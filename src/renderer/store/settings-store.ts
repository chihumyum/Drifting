import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type ThemeMode = 'light' | 'dark' | 'system';
export type AppearanceSkin = 'classic' | 'modern';
export type FocusLineMode = 'off' | 'paragraph' | 'line' | 'sentence';
export type ParagraphIndent = 'none' | 'one' | 'two';
export type LineHeight = 1.5 | 1.65 | 1.72 | 1.8 | 2.0;
export type ModelTier = 'lite' | 'standard' | 'pro';
export type CopilotMode = 'local' | 'cloud';
export type LocaleCode = 'zh-CN' | 'zh-TW' | 'en' | 'ja' | 'ko' | 'fr';
export type DateFormat = 'cjk' | 'iso' | 'us';
export type OrbCorner = 'tl' | 'tr' | 'bl' | 'br';
export type EditPermission = 'suggest' | 'small' | 'all';
export type SurfaceMode = 'never' | 'keyMoments' | 'all';
export type FinishNotify = 'silent' | 'stack' | 'system';
export type ShadowVoice = 'restrained' | 'direct' | 'sharp';

export type CopilotTaskId =
  | 'continuityCheck'
  | 'timelineAlign'
  | 'elementExtract'
  | 'elementPatch'
  | 'autoLink'
  | 'polish'
  | 'research';

export const COPILOT_TASKS: { id: CopilotTaskId; label: string; desc: string }[] = [
  { id: 'continuityCheck', label: '人物一致性核查', desc: '识别人物在不同章节的设定冲突' },
  { id: 'timelineAlign', label: '时间线对齐', desc: '对齐章节与时间线锚点' },
  { id: 'elementExtract', label: '元素抽取', desc: '从手稿中抽取人物 / 地点 / 物件' },
  { id: 'elementPatch', label: '元素补丁建议', desc: '从段落里发现已有人物/地点的状态变化，生成 patch 提案' },
  { id: 'autoLink', label: '自动链接', desc: '把正文里出现的元素自动挂载到元素页面' },
  { id: 'polish', label: '语言润色', desc: '挑出生硬或重复的句式作为批注' },
  { id: 'research', label: '资料检索', desc: '联网核查史实、地理、风物等' },
];

/**
 * Per-task configuration. `debounceMs` undefined = inherit the capability's
 * `defaultDebounceMs` declaration; explicit number = user override. Future
 * advanced knobs (confidence threshold, model, max suggestions) will live
 * alongside these — see CopilotCapability.configSchema for the declaration
 * side and PR D-2 settings UI for the surface.
 */
export interface CopilotTaskConfig {
  enabled: boolean;
  debounceMs?: number;
}

/** Initial value for a newly-encountered task id. */
function defaultTaskConfig(enabled: boolean): CopilotTaskConfig {
  return { enabled };
}

/** All known task ids with their first-run defaults. */
function buildInitialTaskConfigs(): Record<CopilotTaskId, CopilotTaskConfig> {
  const out = {} as Record<CopilotTaskId, CopilotTaskConfig>;
  for (const t of COPILOT_TASKS) {
    // elementExtract / elementPatch are the two wired capabilities — default
    // on so a fresh install actually does something. The placeholders stay
    // off until their capabilities ship.
    const on = t.id === 'elementExtract' || t.id === 'elementPatch' || t.id === 'autoLink' || t.id === 'continuityCheck';
    out[t.id] = defaultTaskConfig(on);
  }
  return out;
}

interface SettingsState {
  // 编辑器既有偏好
  autoElementLinkEnabled: boolean;
  setAutoElementLinkEnabled: (enabled: boolean) => void;
  recentEntitiesLimit: number;
  setRecentEntitiesLimit: (count: number) => void;
  editorUndoDepth: number;
  setEditorUndoDepth: (count: number) => void;

  // 外观
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  shadowAffectsTheme: boolean;
  setShadowAffectsTheme: (on: boolean) => void;
  // Classic = literary manuscript palette (oxblood, serif). Modern = Craft /
  // Arc-style: muted blue-gray accent, pastel story colors, sans-serif body,
  // pure-white doc surface. App.tsx pipes this into `data-skin` on <html>;
  // index.css remaps tokens accordingly. No per-page JS branching.
  appearanceSkin: AppearanceSkin;
  setAppearanceSkin: (skin: AppearanceSkin) => void;

  // 编辑器
  bodyFontSize: number;
  setBodyFontSize: (px: number) => void;
  lineHeight: LineHeight;
  setLineHeight: (h: LineHeight) => void;
  paragraphIndent: ParagraphIndent;
  setParagraphIndent: (indent: ParagraphIndent) => void;
  maxLineWidth: number;
  setMaxLineWidth: (px: number) => void;
  focusLine: FocusLineMode;
  setFocusLine: (mode: FocusLineMode) => void;
  entityHighlight: boolean;
  setEntityHighlight: (on: boolean) => void;
  entityLinkInteractive: boolean;
  setEntityLinkInteractive: (on: boolean) => void;
  autosave: boolean;
  setAutosave: (on: boolean) => void;

  // 语言
  uiLocale: LocaleCode;
  setUiLocale: (l: LocaleCode) => void;
  manuscriptLocale: LocaleCode;
  setManuscriptLocale: (l: LocaleCode) => void;
  spellcheck: boolean;
  setSpellcheck: (on: boolean) => void;
  dateFormat: DateFormat;
  setDateFormat: (f: DateFormat) => void;

  // 模型与 API — note: API keys are NOT here. They live in the OS keychain
  // via `byok-keychain.ts`. Storing them in this persisted store would put
  // them in plaintext localStorage. Only non-secret config belongs here.
  modelTier: ModelTier;
  setModelTier: (t: ModelTier) => void;
  ollamaEndpoint: string;
  setOllamaEndpoint: (s: string) => void;
  uploadFullManuscript: boolean;
  setUploadFullManuscript: (on: boolean) => void;
  allowWebSearch: boolean;
  setAllowWebSearch: (on: boolean) => void;
  requestTimeoutSec: number;
  setRequestTimeoutSec: (s: number) => void;

  // Shadow Agent
  orbCorner: OrbCorner;
  setOrbCorner: (c: OrbCorner) => void;
  surfaceMode: SurfaceMode;
  setSurfaceMode: (m: SurfaceMode) => void;
  finishNotify: FinishNotify;
  setFinishNotify: (m: FinishNotify) => void;
  editPermission: EditPermission;
  setEditPermission: (p: EditPermission) => void;
  agentCreateElements: boolean;
  setAgentCreateElements: (on: boolean) => void;
  agentEditTimeline: boolean;
  setAgentEditTimeline: (on: boolean) => void;
  agentWebSearch: boolean;
  setAgentWebSearch: (on: boolean) => void;
  shadowVoice: ShadowVoice;
  setShadowVoice: (v: ShadowVoice) => void;
  shadowSystemPrompt: string;
  setShadowSystemPrompt: (s: string) => void;

  // Copilot (任务自动化, 没有续写)
  copilotEnabled: boolean;
  setCopilotEnabled: (on: boolean) => void;
  copilotMode: CopilotMode;
  setCopilotMode: (m: CopilotMode) => void;
  /**
   * Per-task configuration map. Each task carries its own enabled flag
   * and an optional debounceMs override (undefined = fall back to the
   * capability's `defaultDebounceMs`). Replaces the legacy
   * `copilotTasks: CopilotTaskId[]` + global `copilotDebounceMs` pair
   * with a richer shape that PR D-2 can extend (model, threshold, etc).
   */
  copilotTaskConfigs: Record<CopilotTaskId, CopilotTaskConfig>;
  setCopilotTaskEnabled: (id: CopilotTaskId, on: boolean) => void;
  setCopilotTaskDebounceMs: (id: CopilotTaskId, ms: number | undefined) => void;
  setCopilotTaskConfig: (id: CopilotTaskId, patch: Partial<CopilotTaskConfig>) => void;
  /**
   * Master switch for the rolling-summary side-output. When true, Copilot
   * accumulates uncovered-block count across capability fires and triggers
   * a block-section summary once `copilotSummarySectionSize` distinct
   * blocks are uncovered. When false: no summaries are generated, no
   * priorSections context is sent to prompts — saves token cost at the
   * expense of element-patch / element-candidate quality.
   */
  copilotGenerateSummaries: boolean;
  setCopilotGenerateSummaries: (on: boolean) => void;
  /**
   * How many distinct uncovered blocks must accumulate before any
   * capability's fire triggers a new summary. Larger = fewer summary
   * calls (cheaper) + bigger context per call. Default 8 covers ~half
   * a typical scene.
   */
  copilotSummarySectionSize: number;
  setCopilotSummarySectionSize: (n: number) => void;

  // 同步
  wifiOnlySync: boolean;
  setWifiOnlySync: (on: boolean) => void;
  autoSnapshot: boolean;
  setAutoSnapshot: (on: boolean) => void;
  syncDebugToasts: boolean;
  setSyncDebugToasts: (on: boolean) => void;

  // 隐私
  improveModelsWithManuscripts: boolean;
  setImproveModelsWithManuscripts: (on: boolean) => void;
  sendUsageStats: boolean;
  setSendUsageStats: (on: boolean) => void;
  sendCrashLogs: boolean;
  setSendCrashLogs: (on: boolean) => void;
}

function clamp(n: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      autoElementLinkEnabled: true,
      setAutoElementLinkEnabled: (enabled) => set({ autoElementLinkEnabled: enabled }),
      recentEntitiesLimit: 10,
      setRecentEntitiesLimit: (count) => set({ recentEntitiesLimit: clamp(count, 1, 50, 10) }),
      editorUndoDepth: 100,
      setEditorUndoDepth: (count) => set({ editorUndoDepth: clamp(count, 10, 1000, 100) }),

      themeMode: 'light',
      setThemeMode: (mode) => set({ themeMode: mode }),
      shadowAffectsTheme: true,
      setShadowAffectsTheme: (on) => set({ shadowAffectsTheme: on }),
      appearanceSkin: 'classic',
      setAppearanceSkin: (skin) => set({ appearanceSkin: skin }),

      bodyFontSize: 17,
      setBodyFontSize: (px) => set({ bodyFontSize: clamp(px, 12, 28, 17) }),
      lineHeight: 1.72,
      setLineHeight: (h) => set({ lineHeight: h }),
      paragraphIndent: 'none',
      setParagraphIndent: (i) => set({ paragraphIndent: i }),
      maxLineWidth: 720,
      setMaxLineWidth: (px) => set({ maxLineWidth: clamp(px, 480, 1280, 720) }),
      focusLine: 'paragraph',
      setFocusLine: (m) => set({ focusLine: m }),
      entityHighlight: true,
      setEntityHighlight: (on) => set({ entityHighlight: on }),
      entityLinkInteractive: true,
      setEntityLinkInteractive: (on) => set({ entityLinkInteractive: on }),
      autosave: true,
      setAutosave: (on) => set({ autosave: on }),

      uiLocale: 'zh-CN',
      setUiLocale: (l) => set({ uiLocale: l }),
      manuscriptLocale: 'zh-CN',
      setManuscriptLocale: (l) => set({ manuscriptLocale: l }),
      spellcheck: true,
      setSpellcheck: (on) => set({ spellcheck: on }),
      dateFormat: 'cjk',
      setDateFormat: (f) => set({ dateFormat: f }),

      modelTier: 'standard',
      setModelTier: (t) => set({ modelTier: t }),
      ollamaEndpoint: 'http://localhost:11434',
      setOllamaEndpoint: (s) => set({ ollamaEndpoint: s }),
      uploadFullManuscript: true,
      setUploadFullManuscript: (on) => set({ uploadFullManuscript: on }),
      allowWebSearch: true,
      setAllowWebSearch: (on) => set({ allowWebSearch: on }),
      requestTimeoutSec: 90,
      setRequestTimeoutSec: (s) => set({ requestTimeoutSec: clamp(s, 10, 600, 90) }),

      orbCorner: 'br',
      setOrbCorner: (c) => set({ orbCorner: c }),
      surfaceMode: 'keyMoments',
      setSurfaceMode: (m) => set({ surfaceMode: m }),
      finishNotify: 'stack',
      setFinishNotify: (m) => set({ finishNotify: m }),
      editPermission: 'suggest',
      setEditPermission: (p) => set({ editPermission: p }),
      agentCreateElements: true,
      setAgentCreateElements: (on) => set({ agentCreateElements: on }),
      agentEditTimeline: false,
      setAgentEditTimeline: (on) => set({ agentEditTimeline: on }),
      agentWebSearch: true,
      setAgentWebSearch: (on) => set({ agentWebSearch: on }),
      shadowVoice: 'direct',
      setShadowVoice: (v) => set({ shadowVoice: v }),
      shadowSystemPrompt:
        '你是一位熟读明清白话小说与近代翻译腔的编辑。优先关注：人物动机的连贯、时间线的隐蔽冲突、语言节奏。避免改动叙述视角；当确实需要时，先给出标记，再让作者决定。',
      setShadowSystemPrompt: (s) => set({ shadowSystemPrompt: s }),

      copilotEnabled: true,
      setCopilotEnabled: (on) => set({ copilotEnabled: on }),
      copilotMode: 'cloud',
      setCopilotMode: (m) => set({ copilotMode: m }),
      copilotTaskConfigs: buildInitialTaskConfigs(),
      setCopilotTaskEnabled: (id, on) =>
        set((state) => ({
          copilotTaskConfigs: {
            ...state.copilotTaskConfigs,
            [id]: { ...(state.copilotTaskConfigs[id] ?? defaultTaskConfig(false)), enabled: on },
          },
        })),
      setCopilotTaskDebounceMs: (id, ms) =>
        set((state) => ({
          copilotTaskConfigs: {
            ...state.copilotTaskConfigs,
            [id]: { ...(state.copilotTaskConfigs[id] ?? defaultTaskConfig(false)), debounceMs: ms },
          },
        })),
      setCopilotTaskConfig: (id, patch) =>
        set((state) => ({
          copilotTaskConfigs: {
            ...state.copilotTaskConfigs,
            [id]: { ...(state.copilotTaskConfigs[id] ?? defaultTaskConfig(false)), ...patch },
          },
        })),
      copilotGenerateSummaries: true,
      setCopilotGenerateSummaries: (on) => set({ copilotGenerateSummaries: on }),
      copilotSummarySectionSize: 8,
      setCopilotSummarySectionSize: (n) => set({ copilotSummarySectionSize: n }),

      wifiOnlySync: true,
      setWifiOnlySync: (on) => set({ wifiOnlySync: on }),
      autoSnapshot: true,
      setAutoSnapshot: (on) => set({ autoSnapshot: on }),
      syncDebugToasts: false,
      setSyncDebugToasts: (on) => set({ syncDebugToasts: on }),

      improveModelsWithManuscripts: false,
      setImproveModelsWithManuscripts: (on) => set({ improveModelsWithManuscripts: on }),
      sendUsageStats: true,
      setSendUsageStats: (on) => set({ sendUsageStats: on }),
      sendCrashLogs: true,
      setSendCrashLogs: (on) => set({ sendCrashLogs: on }),
    }),
    {
      name: 'settings-storage',
      storage: createJSONStorage(() => localStorage),
      version: 7,
      migrate: (persistedState, version) => {
        const state = persistedState as Partial<SettingsState> & {
          manuscriptSans?: boolean;
          marginNotes?: boolean;
          marginNotesByKind?: unknown;
          animationsEnabled?: boolean;
          copilotTasks?: CopilotTaskId[];
          copilotDebounceMs?: number;
        };
        let next: Partial<SettingsState> & {
          manuscriptSans?: boolean;
          marginNotes?: boolean;
          marginNotesByKind?: unknown;
          animationsEnabled?: boolean;
          copilotTasks?: CopilotTaskId[];
          copilotDebounceMs?: number;
        } = state;
        if (version < 2) {
          // manuscriptSans is subsumed by appearanceSkin = 'modern' (which
          // remaps --font-serif to the sans stack). Users who had it on get
          // upgraded to the full modern palette; the alternative (silently
          // dropping the preference) feels worse.
          const wasSans = (state as { manuscriptSans?: boolean }).manuscriptSans === true;
          const { manuscriptSans: _omit, ...rest } = next;
          void _omit;
          next = { ...rest, appearanceSkin: wasSans ? 'modern' : 'classic' };
        }
        if (version < 4) {
          // The margin-notes toggle moved out of global settings entirely —
          // each entity editor now persists its own toggle under a separate
          // localStorage key (see lib/entity-margin-notes.ts). Drop both the
          // old global flag and the short-lived per-kind shape.
          const { marginNotes: _a, marginNotesByKind: _b, ...rest } = next;
          void _a;
          void _b;
          next = rest;
        }
        if (version < 5) {
          // animationsEnabled retired — the global on/off was never a useful
          // dial in practice (per-feature transitions are tuned individually
          // now). Drop the persisted flag so it doesn't linger forever.
          const { animationsEnabled: _omit, ...rest } = next;
          void _omit;
          next = rest;
        }
        if (version < 6) {
          // copilotTasks (string[] allow-list) + copilotDebounceMs (single
          // global) folded into copilotTaskConfigs (per-task enabled +
          // optional debounceMs). Migration preserves each user's prior
          // choices: enabled = was in the allow-list; debounceMs = old
          // global if non-default, else undefined (capability default).
          const oldTasks = (next.copilotTasks ?? []) as string[];
          const oldGlobalDebounce = next.copilotDebounceMs;
          const configs = buildInitialTaskConfigs();
          // If user had an explicit allow-list, respect it (overrides initial
          // defaults). Empty list = nothing was on → set everything off.
          // Note: 'entityExtract' was the old name for what is now
          // 'elementExtract' (PR E rename), but at v5 it was still the old
          // name in storage. The v7 migration below handles the key rename;
          // this v6 step preserves it as-is.
          if (oldTasks.length > 0) {
            for (const id of Object.keys(configs) as CopilotTaskId[]) {
              configs[id] = { ...configs[id], enabled: oldTasks.includes(id) };
            }
          }
          // Apply old global debounce only to currently-wired caps. The placeholders
          // would otherwise carry a debounce setting they can't act on.
          if (typeof oldGlobalDebounce === 'number' && oldGlobalDebounce > 0) {
            for (const id of ['elementExtract', 'elementPatch'] as CopilotTaskId[]) {
              configs[id] = { ...configs[id], debounceMs: oldGlobalDebounce };
            }
          }
          const {
            copilotTasks: _omitTasks,
            copilotDebounceMs: _omitDebounce,
            ...rest
          } = next;
          void _omitTasks;
          void _omitDebounce;
          next = { ...rest, copilotTaskConfigs: configs };
        }
        if (version < 7) {
          // PR E: 'entityExtract' task id renamed to 'elementExtract' (it
          // was always BookElement-targeted; the old "entity" name conflated
          // it with Drifting's broader entity union). Move the config under
          // the new key, then drop the old one if both somehow co-exist
          // (new key wins — it's what current code reads).
          const configs = { ...(next.copilotTaskConfigs ?? {}) } as Record<string, CopilotTaskConfig>;
          if (configs.entityExtract && !configs.elementExtract) {
            configs.elementExtract = configs.entityExtract;
          }
          delete configs.entityExtract;
          next = { ...next, copilotTaskConfigs: configs as Record<CopilotTaskId, CopilotTaskConfig> };
        }
        return next;
      },
    },
  ),
);
