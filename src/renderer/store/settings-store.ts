import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { BYOKProvider } from '../lib/byok-keychain';
import {
  AGENT_PROVIDER_OPTIONS,
  DEFAULT_AGENT_PROVIDER,
  agentProviderOption,
  normalizeAgentProviderEffort,
  normalizeAgentProvider,
  normalizeAgentProviderModel,
  normalizeAgentProviderThinking,
  resolveAgentProviderReasoningProfile,
  type AgentProviderId,
} from '../lib/agent/runtime/agent-provider-contract';
import { APP_CONFIG } from '../lib/config';
import {
  DEFAULT_ENTITY_LINK_KIND_COLORS,
  normalizeEntityLinkColorMode,
  normalizeEntityLinkHexColor,
  normalizeEntityLinkKindColors,
  type EntityLinkColorKind,
  type EntityLinkColorMode,
  type EntityLinkKindColors,
} from '../lib/entity-link-appearance';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ParagraphIndent = 'none' | 'one' | 'two';
export type EditorFontSource =
  | 'system-serif'
  | 'system-sans'
  | 'system-mono'
  | 'system-custom'
  | 'imported';
/** Editor line height, a free ratio in [1.0, 2.0] (slider, clamped on set). */
export type LineHeight = number;
export const TYPEWRITER_POSITION_MIN = 25;
export const TYPEWRITER_POSITION_MAX = 75;
export const TYPEWRITER_POSITION_DEFAULT = 50;
export const CARET_COLOR_DEFAULT = '#6b7fa6';
export type OutlineRailMode = 'always' | 'auto' | 'hidden';
export const OUTLINE_RAIL_MODE_DEFAULT: OutlineRailMode = 'auto';

export function normalizeOutlineRailMode(value: unknown): OutlineRailMode {
  return value === 'always' || value === 'auto' || value === 'hidden'
    ? value
    : OUTLINE_RAIL_MODE_DEFAULT;
}

export function normalizeCaretColor(color: unknown): string {
  return typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)
    ? color.toLowerCase()
    : CARET_COLOR_DEFAULT;
}

/**
 * Recommended editor typography / layout defaults. Single source of truth for
 * both the store's initial state and the "还原推荐样式" reset action, so the two
 * can never drift apart.
 */
export const EDITOR_STYLE_DEFAULTS = {
  editorFontSource: 'system-serif',
  bodyFontSize: 17,
  lineHeight: 1.5,
  paragraphIndent: 'none',
  editorIndentStep: 2,
  paragraphSpacing: 1.0,
  maxLineWidth: 720,
} satisfies {
  editorFontSource: EditorFontSource;
  bodyFontSize: number;
  lineHeight: LineHeight;
  paragraphIndent: ParagraphIndent;
  editorIndentStep: number;
  paragraphSpacing: number;
  maxLineWidth: number;
};
export type ModelTier = 'lite' | 'standard' | 'pro';
export type CopilotMode = 'local' | 'cloud';
/**
 * Where copilot LLM calls get their credential (Phase 4).
 *  - 'hosted': the Drifting server uses its own provider key (metered/billed).
 *  - 'byok':   the user's own key (from the OS keychain) is sent per-request so
 *              the server calls the provider with it. Never persisted server-side.
 */
export type AiMode = 'hosted' | 'byok';
/**
 * Legacy General-Agent credential token retained for persisted compatibility.
 * The current provider-neutral local runtime always uses `apikey`, resolving the
 * selected provider from the global `byok.<provider>` Keychain namespace.
 */
export type AgentAuth = 'hosted' | 'oauth' | 'apikey';
/**
 * General-Agent (Claude Agent SDK) model. The SDK's `model` is a free string:
 * a tier alias ('opus'/'sonnet'/'haiku', resolves to the latest of that tier),
 * a pinned full model id ('claude-opus-4-8', …), or 'default' = inherit the
 * CLI/subscription default (we omit the field). See AGENT_MODEL_OPTIONS.
 */
export type AgentModel = string;
/**
 * Reasoning effort passed to the SDK. Full range per the TS SDK docs
 * (low|medium|high|xhigh|max); 'high' is the default. xhigh/max are only
 * supported by some Opus versions — the SDK falls back / errors otherwise.
 */
export type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** Extended-thinking mode: 'adaptive' = model decides; 'off' = disabled. */
export type AgentThinking = 'adaptive' | 'off';
/**
 * Provider-neutral runtime tool selection.
 *  - 'off':  expose every currently certified definition.
 *  - 'auto': select at most the runtime hard limit when the certified catalog
 *            is larger than that limit.
 *  - 'on':   always run the same bounded selector.
 */
export type AgentToolSearch = 'off' | 'auto' | 'on';

/** Product default for a fresh General Agent installation. */
export const AGENT_TOOL_SEARCH_DEFAULT: AgentToolSearch = 'auto';

/**
 * Keep an explicit persisted choice, including `off`, while giving new or
 * pre-setting installs the current product default.
 */
export function normalizeAgentToolSearch(value: unknown): AgentToolSearch {
  return value === 'off' || value === 'auto' || value === 'on' ? value : AGENT_TOOL_SEARCH_DEFAULT;
}

/** One-time v20 migration: the old default `off` was not product-usable. */
export function migrateAgentToolSearch(value: unknown, persistedVersion: number): AgentToolSearch {
  return persistedVersion < 20 ? AGENT_TOOL_SEARCH_DEFAULT : normalizeAgentToolSearch(value);
}

/** Tool-search options for the settings picker. */
export const AGENT_TOOL_SEARCH_OPTIONS: { value: AgentToolSearch; label: string }[] = [
  { value: 'off', label: 'Off · load all tools' },
  { value: 'auto', label: 'Auto · enable above threshold' },
  { value: 'on', label: 'On · force tool search' },
];
/**
 * How committed General Agent prose edits surface in the editor:
 *  - 'auto':    play the colored reveal and settle the visual batch.
 *  - 'approve': keep the inline diff and accept/reject badge; rejection runs the
 *               canonical guarded inverse.
 * This does not grant structural authority. Destructive graph/entity operations
 * keep their independent confirm-before permission policy.
 */
export type AgentEditMode = 'auto' | 'approve';

/**
 * The model picker's catalog (shared by Settings and the input-bar switcher).
 * `short` is the compact label for the narrow in-panel picker. Tier aliases
 * track the latest of each family; pinned ids name an exact version.
 */
/** @deprecated Prefer `agentProviderOption(provider).models`. */
export const AGENT_MODEL_OPTIONS = AGENT_PROVIDER_OPTIONS.flatMap((provider) => provider.models);
export { AGENT_PROVIDER_OPTIONS, agentProviderOption, resolveAgentProviderReasoningProfile };
export type { AgentProviderId };

/** Effort levels for the pickers, with compact labels. */
export const AGENT_EFFORT_OPTIONS: { value: AgentEffort; label: string; short: string }[] = [
  { value: 'low', label: 'Low', short: 'Low' },
  { value: 'medium', label: 'Medium', short: 'Med' },
  { value: 'high', label: 'High', short: 'High' },
  { value: 'xhigh', label: 'X-High', short: 'XHigh' },
  { value: 'max', label: 'Max', short: 'Max' },
];
export type LocaleCode = 'zh-CN' | 'zh-TW' | 'en' | 'ja' | 'ko' | 'fr';
/** Per-project Copilot output language. 'auto' = follow manuscriptLocale. */
export type CopilotOutputLang = LocaleCode | 'auto';
export type DateFormat = 'cjk' | 'iso' | 'us';

function normalizeUiLocale(locale: LocaleCode): LocaleCode {
  return locale.startsWith('zh') ? 'zh-CN' : 'en';
}

// The AUTO-task switches — only the wired, debounced copilot capabilities. The
// unimplemented placeholders (人物一致性核查 / 时间线对齐 / 自动链接 / 语言润色 /
// 资料检索) were removed — they rendered toggles that did nothing. elementExtract
// + elementPatch are the two debounced capabilities. Inline-edit (⇧⌘I) and the
// popover「问」are MANUAL — always available, never gated by a task switch — so
// they are deliberately NOT listed here. The task-toggle UIs (settings panel +
// bottom menu) iterate COPILOT_TASKS, so a manual feature never gets a switch.
export type CopilotTaskId = 'elementExtract' | 'elementPatch';

export const COPILOT_TASKS: { id: CopilotTaskId; label: string; desc: string }[] = [
  {
    id: 'elementExtract',
    label: 'Element extraction',
    desc: 'Extract people, places, and objects from the manuscript',
  },
  {
    id: 'elementPatch',
    label: 'Element patch suggestions',
    desc: 'Detect state changes for existing people or places and draft patch proposals',
  },
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
    // Both remaining tasks are wired — default them on so a fresh install
    // actually does something.
    out[t.id] = defaultTaskConfig(true);
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

  // 编辑器
  /** Device-local because installed/imported font availability is not portable. */
  editorFontSource: EditorFontSource;
  setEditorFontSource: (source: EditorFontSource) => void;
  editorSystemFontFamily: string;
  setEditorSystemFontFamily: (family: string) => void;
  bodyFontSize: number;
  setBodyFontSize: (px: number) => void;
  lineHeight: LineHeight;
  setLineHeight: (h: LineHeight) => void;
  paragraphIndent: ParagraphIndent;
  setParagraphIndent: (indent: ParagraphIndent) => void;
  // Em per Tab indent level (block left-indent, ParagraphIndent extension).
  editorIndentStep: number;
  setEditorIndentStep: (em: number) => void;
  // Vertical gap between paragraphs (em), editor view only.
  paragraphSpacing: number;
  setParagraphSpacing: (em: number) => void;
  maxLineWidth: number;
  setMaxLineWidth: (px: number) => void;
  // Restore all of the above editor typography/layout fields to
  // EDITOR_STYLE_DEFAULTS in one shot.
  resetEditorStyle: () => void;
  /** Keep the active prose caret line at a stable viewport position. */
  typewriterMode: boolean;
  setTypewriterMode: (enabled: boolean) => void;
  /** Vertical caret target as a percentage from the top of the editor viewport. */
  typewriterPosition: number;
  setTypewriterPosition: (percent: number) => void;
  caretColor: string;
  setCaretColor: (color: string) => void;
  outlineRailMode: OutlineRailMode;
  setOutlineRailMode: (mode: OutlineRailMode) => void;
  entityLinkInteractive: boolean;
  setEntityLinkInteractive: (on: boolean) => void;
  entityLinkColorMode: EntityLinkColorMode;
  setEntityLinkColorMode: (mode: EntityLinkColorMode) => void;
  entityLinkKindColors: EntityLinkKindColors;
  setEntityLinkKindColor: (kind: EntityLinkColorKind, color: string) => void;
  setEntityLinkKindColors: (colors: unknown) => void;
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

  // Copilot (跟随式副手) provider config — note: API keys are NOT here. They
  // live in the OS keychain via `byok-keychain.ts`. Storing them in this
  // persisted store would put them in plaintext localStorage. Only non-secret
  // config belongs here.
  // Hosted tier: a coarse capability档 (the server maps it to a concrete model).
  copilotTier: ModelTier;
  setCopilotTier: (t: ModelTier) => void;
  // 'hosted' (server key, metered) vs 'byok' (user's own key, sent per-request).
  copilotAiMode: AiMode;
  setCopilotAiMode: (m: AiMode) => void;
  // Which provider the BYOK path uses (the key for it must be in the keychain).
  copilotByokProvider: BYOKProvider;
  setCopilotByokProvider: (p: BYOKProvider) => void;
  // The concrete model id within the BYOK provider ('' = let the server pick the
  // provider default). Only meaningful when copilotAiMode === 'byok'.
  copilotByokModel: string;
  setCopilotByokModel: (m: string) => void;

  // General Agent credential token. Current BYOK-only builds coerce this to
  // `apikey`; the actual provider/model are chosen in the chat composer.
  agentAuth: AgentAuth;
  setAgentAuth: (a: AgentAuth) => void;
  // Provider/model are captured into each turn before provider I/O. Changing a
  // setting never reroutes an already-running turn.
  agentProvider: AgentProviderId;
  setAgentProvider: (provider: AgentProviderId) => void;
  agentModel: AgentModel;
  setAgentModel: (m: AgentModel) => void;
  /** Requests the selected model's declared context window, capped at 1M. */
  agentMaxContext: boolean;
  setAgentMaxContext: (on: boolean) => void;
  agentEffort: AgentEffort;
  setAgentEffort: (e: AgentEffort) => void;
  agentThinking: AgentThinking;
  setAgentThinking: (t: AgentThinking) => void;
  // Tool-search mode (ENABLE_TOOL_SEARCH). See AgentToolSearch.
  agentToolSearch: AgentToolSearch;
  setAgentToolSearch: (t: AgentToolSearch) => void;
  // How committed Agent prose edits surface in the editor: `auto` plays the
  // colored reveal and settles, while `approve` keeps an inline diff/badge whose
  // rejection calls the canonical guarded inverse. Destructive structural
  // permissions are independent and always handled before execution.
  agentEditMode: AgentEditMode;
  setAgentEditMode: (m: AgentEditMode) => void;
  // Copilot (任务自动化, 没有续写)
  /**
   * The single switch for AUTOMATIC Copilot. When on, background tasks run on
   * their own as you write (debounced capability fire, todo parsing, segment
   * summaries). When off, nothing fires automatically — but manual triggers
   * (⇧⌘I / the context-menu Copilot popover) keep working regardless, since
   * those are user-initiated.
   */
  copilotAutoTrigger: boolean;
  setCopilotAutoTrigger: (on: boolean) => void;
  copilotMode: CopilotMode;
  setCopilotMode: (m: CopilotMode) => void;
  /**
   * Whether Copilot runs inside the drift-node editor. Drift nodes are
   * scratch / inspiration space, so by default we keep the副手 quiet there
   * even when the master switch is on — it stays active in chapter editors.
   * Flip on to get the same task suggestions in drifts.
   */
  copilotInDrift: boolean;
  setCopilotInDrift: (on: boolean) => void;
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
  /**
   * Inline-edit (Cmd+Shift+I) escape hatch. Default false: inline-edit refuses to
   * generate NEW story content because it runs without the project / chapter
   * / storyline context the rest of Copilot assembles. Flip on to let it
   * fulfill "continue this" style asks — the author then owns the quality
   * loss from the missing global context.
   */
  copilotInlineEditAllowNewContent: boolean;
  setCopilotInlineEditAllowNewContent: (on: boolean) => void;
  /**
   * Per-project output language for Copilot generation,
   * keyed by projectId. 'auto'/unset follows manuscriptLocale. Keeps the
   * 副手 from drifting into the wrong language (e.g. English in a Chinese
   * novel). Synced to the server (so the server resolves output language for
   * copilot calls) via the preferences whitelist.
   */
  copilotOutputLangByProject: Record<string, CopilotOutputLang>;
  setCopilotOutputLang: (projectId: string, lang: CopilotOutputLang) => void;
  /** Replace the whole per-project map — used by cross-device preferences sync. */
  setCopilotOutputLangByProject: (map: Record<string, CopilotOutputLang>) => void;

  /**
   * Last-active Agent conversation id per project. Persisted so the Agent panel
   * re-opens the session the user was in after a reload/restart (the transcript
   * itself lives in SQLite agent_conversation). Cleared when a conversation is
   * started fresh or deleted while active.
   */
  lastAgentConvByProject: Record<string, string>;
  setLastAgentConv: (projectId: string, convId: string) => void;
  clearLastAgentConv: (projectId: string) => void;

  // 同步
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

// Like clamp, but preserves fractional values (clamp floors to an integer,
// which is right for px counts but wrong for typographic ratios like line
// height / paragraph spacing / indent-step em).
function clampFloat(n: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
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

      editorFontSource: EDITOR_STYLE_DEFAULTS.editorFontSource,
      setEditorFontSource: (source) => set({ editorFontSource: source }),
      editorSystemFontFamily: '',
      setEditorSystemFontFamily: (family) =>
        set({ editorSystemFontFamily: family.trim().slice(0, 128) }),
      bodyFontSize: EDITOR_STYLE_DEFAULTS.bodyFontSize,
      setBodyFontSize: (px) => set({ bodyFontSize: clamp(px, 12, 28, 17) }),
      lineHeight: EDITOR_STYLE_DEFAULTS.lineHeight,
      setLineHeight: (h) => set({ lineHeight: clampFloat(h, 1.0, 2.0, 1.5) }),
      paragraphIndent: EDITOR_STYLE_DEFAULTS.paragraphIndent,
      setParagraphIndent: (i) => set({ paragraphIndent: i }),
      editorIndentStep: EDITOR_STYLE_DEFAULTS.editorIndentStep,
      setEditorIndentStep: (em) => set({ editorIndentStep: clampFloat(em, 0.5, 6, 2) }),
      paragraphSpacing: EDITOR_STYLE_DEFAULTS.paragraphSpacing,
      setParagraphSpacing: (em) => set({ paragraphSpacing: clampFloat(em, 0, 3, 1.0) }),
      maxLineWidth: EDITOR_STYLE_DEFAULTS.maxLineWidth,
      setMaxLineWidth: (px) => set({ maxLineWidth: clamp(px, 480, 1280, 720) }),
      resetEditorStyle: () => set({ ...EDITOR_STYLE_DEFAULTS }),
      typewriterMode: false,
      setTypewriterMode: (enabled) => set({ typewriterMode: enabled }),
      typewriterPosition: TYPEWRITER_POSITION_DEFAULT,
      setTypewriterPosition: (percent) =>
        set({
          typewriterPosition: clamp(
            percent,
            TYPEWRITER_POSITION_MIN,
            TYPEWRITER_POSITION_MAX,
            TYPEWRITER_POSITION_DEFAULT,
          ),
        }),
      caretColor: CARET_COLOR_DEFAULT,
      setCaretColor: (color) => set({ caretColor: normalizeCaretColor(color) }),
      outlineRailMode: OUTLINE_RAIL_MODE_DEFAULT,
      setOutlineRailMode: (mode) => set({ outlineRailMode: normalizeOutlineRailMode(mode) }),
      entityLinkInteractive: true,
      setEntityLinkInteractive: (on) => set({ entityLinkInteractive: on }),
      entityLinkColorMode: 'contextual',
      setEntityLinkColorMode: (mode) =>
        set({ entityLinkColorMode: normalizeEntityLinkColorMode(mode) }),
      entityLinkKindColors: { ...DEFAULT_ENTITY_LINK_KIND_COLORS },
      setEntityLinkKindColor: (kind, color) =>
        set((state) => ({
          entityLinkKindColors: {
            ...state.entityLinkKindColors,
            [kind]: normalizeEntityLinkHexColor(color, state.entityLinkKindColors[kind]),
          },
        })),
      setEntityLinkKindColors: (colors) =>
        set({ entityLinkKindColors: normalizeEntityLinkKindColors(colors) }),
      autosave: true,
      setAutosave: (on) => set({ autosave: on }),

      uiLocale: 'zh-CN',
      setUiLocale: (l) => set({ uiLocale: normalizeUiLocale(l) }),
      manuscriptLocale: 'zh-CN',
      setManuscriptLocale: (l) => set({ manuscriptLocale: l }),
      spellcheck: true,
      setSpellcheck: (on) => set({ spellcheck: on }),
      dateFormat: 'cjk',
      setDateFormat: (f) => set({ dateFormat: f }),

      // Fresh installs start on BYOK in a BYOK-only build (no hosted key server-side).
      copilotAiMode: 'byok',
      setCopilotAiMode: () => set({ copilotAiMode: 'byok' }),
      copilotByokProvider: 'deepseek',
      setCopilotByokProvider: (p) => set({ copilotByokProvider: p }),
      copilotByokModel: '',
      setCopilotByokModel: (m) => set({ copilotByokModel: m }),
      agentAuth: 'apikey',
      setAgentAuth: (auth) => set({ agentAuth: auth === 'hosted' ? 'apikey' : auth }),
      agentProvider: DEFAULT_AGENT_PROVIDER,
      setAgentProvider: (provider) =>
        set((state) => {
          const normalizedProvider = normalizeAgentProvider(provider);
          const normalizedModel = normalizeAgentProviderModel(normalizedProvider, state.agentModel);
          return {
            agentProvider: normalizedProvider,
            agentModel: normalizedModel,
            agentThinking: normalizeAgentProviderThinking(
              normalizedProvider,
              normalizedModel,
              state.agentThinking,
            ),
            agentEffort: normalizeAgentProviderEffort(
              normalizedProvider,
              normalizedModel,
              state.agentEffort,
            ),
          };
        }),
      agentModel: 'deepseek-v4-flash',
      setAgentModel: (m) =>
        set((state) => {
          const agentModel = normalizeAgentProviderModel(state.agentProvider, m);
          return {
            agentModel,
            agentThinking: normalizeAgentProviderThinking(
              state.agentProvider,
              agentModel,
              state.agentThinking,
            ),
            agentEffort: normalizeAgentProviderEffort(
              state.agentProvider,
              agentModel,
              state.agentEffort,
            ),
          };
        }),
      agentMaxContext: false,
      setAgentMaxContext: (on) => set({ agentMaxContext: on }),
      agentEffort: 'high',
      setAgentEffort: (e) =>
        set((state) => ({
          agentEffort: normalizeAgentProviderEffort(state.agentProvider, state.agentModel, e),
        })),
      agentThinking: 'off',
      setAgentThinking: (t) =>
        set((state) => ({
          agentThinking: normalizeAgentProviderThinking(state.agentProvider, state.agentModel, t),
        })),
      agentToolSearch: AGENT_TOOL_SEARCH_DEFAULT,
      setAgentToolSearch: (t) => set({ agentToolSearch: t }),
      agentEditMode: 'auto',
      setAgentEditMode: (m) => set({ agentEditMode: m }),
      copilotTier: 'standard',
      setCopilotTier: (t) => set({ copilotTier: t }),

      copilotAutoTrigger: true,
      setCopilotAutoTrigger: (on) => set({ copilotAutoTrigger: on }),
      copilotMode: 'cloud',
      setCopilotMode: (m) => set({ copilotMode: m }),
      copilotInDrift: false,
      setCopilotInDrift: (on) => set({ copilotInDrift: on }),
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
      copilotInlineEditAllowNewContent: false,
      setCopilotInlineEditAllowNewContent: (on) => set({ copilotInlineEditAllowNewContent: on }),
      copilotOutputLangByProject: {},
      setCopilotOutputLang: (projectId, lang) =>
        set((state) => ({
          copilotOutputLangByProject: {
            ...state.copilotOutputLangByProject,
            [projectId]: lang,
          },
        })),
      setCopilotOutputLangByProject: (map) => set({ copilotOutputLangByProject: map }),

      lastAgentConvByProject: {},
      setLastAgentConv: (projectId, convId) =>
        set((state) => ({
          lastAgentConvByProject: { ...state.lastAgentConvByProject, [projectId]: convId },
        })),
      clearLastAgentConv: (projectId) =>
        set((state) => {
          if (!(projectId in state.lastAgentConvByProject)) return {};
          const next = { ...state.lastAgentConvByProject };
          delete next[projectId];
          return { lastAgentConvByProject: next };
        }),

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
      version: 27,
      migrate: (persistedState, version) => {
        const state = persistedState as Partial<SettingsState> & {
          appearanceSkin?: 'classic' | 'modern';
          manuscriptSans?: boolean;
          editorSerif?: boolean;
          marginNotes?: boolean;
          marginNotesByKind?: unknown;
          animationsEnabled?: boolean;
          copilotTasks?: CopilotTaskId[];
          copilotDebounceMs?: number;
          // v8→v9 legacy AI keys (renamed/removed below).
          modelTier?: ModelTier;
          aiMode?: AiMode;
          byokProvider?: BYOKProvider;
          agentMode?: AiMode;
          focusLine?: unknown;
        };
        let next: Partial<SettingsState> & {
          appearanceSkin?: 'classic' | 'modern';
          manuscriptSans?: boolean;
          editorSerif?: boolean;
          marginNotes?: boolean;
          marginNotesByKind?: unknown;
          animationsEnabled?: boolean;
          copilotTasks?: CopilotTaskId[];
          copilotDebounceMs?: number;
          modelTier?: ModelTier;
          aiMode?: AiMode;
          byokProvider?: BYOKProvider;
          agentMode?: AiMode;
          focusLine?: unknown;
        } = state;
        if (version < 2) {
          // Preserve the original prose-font preference from the setting that
          // predated the retired application-wide skin.
          const wasSans = (state as { manuscriptSans?: boolean }).manuscriptSans === true;
          const { manuscriptSans: _omit, ...rest } = next;
          void _omit;
          next = { ...rest, editorSerif: !wasSans };
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
          const { copilotTasks: _omitTasks, copilotDebounceMs: _omitDebounce, ...rest } = next;
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
          const configs = { ...(next.copilotTaskConfigs ?? {}) } as Record<
            string,
            CopilotTaskConfig
          >;
          if (configs.entityExtract && !configs.elementExtract) {
            configs.elementExtract = configs.entityExtract;
          }
          delete configs.entityExtract;
          next = {
            ...next,
            copilotTaskConfigs: configs as Record<CopilotTaskId, CopilotTaskConfig>,
          };
        }
        if (version < 8) {
          // New task ids ship over time. Backfill any current
          // COPILOT_TASKS entry missing from the user's persisted configs
          // with its first-run default, so the settings UI and the manual-run
          // menu surface it instead of treating it as silently disabled.
          // Existing user choices are preserved (only missing keys are added).
          const defaults = buildInitialTaskConfigs();
          const configs = {
            ...(next.copilotTaskConfigs ?? {}),
          } as Record<CopilotTaskId, CopilotTaskConfig>;
          for (const id of Object.keys(defaults) as CopilotTaskId[]) {
            if (!configs[id]) configs[id] = defaults[id];
          }
          next = { ...next, copilotTaskConfigs: configs };
        }
        if (version < 9) {
          // AI settings reorg by subsystem. (1) Copilot's generic field names
          // get a `copilot` prefix to disambiguate from the General Agent's
          // routing. (2) `agentMode` (binary hosted/byok-OAuth) becomes the
          // 3-way `agentAuth` — BYOK now splits into 'oauth' and 'apikey'. (3)
          // The never-wired Shadow scaffolding (orb/surface/notify/permissions/
          // voice/prompt) is dropped; no runtime ever consumed it. Each user's
          // prior choices are preserved across the renames.
          const legacy = next;
          if (legacy.modelTier !== undefined && next.copilotTier === undefined) {
            next.copilotTier = legacy.modelTier;
          }
          if (legacy.aiMode !== undefined && next.copilotAiMode === undefined) {
            next.copilotAiMode = legacy.aiMode;
          }
          if (legacy.byokProvider !== undefined && next.copilotByokProvider === undefined) {
            next.copilotByokProvider = legacy.byokProvider;
          }
          if (next.agentAuth === undefined) {
            // Old 'byok' meant the Claude OAuth path; map it to 'oauth'.
            next.agentAuth = legacy.agentMode === 'hosted' ? 'hosted' : 'oauth';
          }
          const drop = next as Record<string, unknown>;
          for (const k of [
            'modelTier',
            'aiMode',
            'byokProvider',
            'agentMode',
            'orbCorner',
            'surfaceMode',
            'finishNotify',
            'editPermission',
            'agentCreateElements',
            'agentEditTimeline',
            'agentWebSearch',
            'shadowVoice',
            'shadowSystemPrompt',
          ]) {
            delete drop[k];
          }
        }
        if (version < 10) {
          // Dropped three knobs the user never needed to control: manuscript
          // upload, request timeout, and the model-web-search toggle. None were
          // ever consumed by a runtime; the General Agent now搜网 unconditionally
          // via the SDK's built-in WebSearch/WebFetch tools.
          const drop = next as Record<string, unknown>;
          for (const k of ['uploadFullManuscript', 'allowWebSearch', 'requestTimeoutSec']) {
            delete drop[k];
          }
        }
        if (version < 12) {
          // 'inlineEdit' is no longer a task: inline-edit (⇧⌘I) is a MANUAL
          // feature, always available, never gated by a switch. Drop its stale
          // persisted config (and any other key no longer in COPILOT_TASKS) so
          // the saved shape matches CopilotTaskId again.
          const known = new Set(COPILOT_TASKS.map((t) => t.id));
          const configs = { ...(next.copilotTaskConfigs ?? {}) } as Record<
            string,
            CopilotTaskConfig
          >;
          for (const id of Object.keys(configs)) {
            if (!known.has(id as CopilotTaskId)) delete configs[id];
          }
          next = {
            ...next,
            copilotTaskConfigs: configs as Record<CopilotTaskId, CopilotTaskConfig>,
          };
        }
        if (version < 14) {
          // The application now has one modern UI. Preserve the only visual
          // choice that belongs to manuscript editing: classic users keep
          // serif prose, while modern users keep sans prose.
          const { appearanceSkin: legacySkin, ...rest } = next;
          next = {
            ...rest,
            editorSerif:
              typeof next.editorSerif === 'boolean' ? next.editorSerif : legacySkin !== 'modern',
          };
        }
        if (version < 15) {
          // Prose typography is now a device-local font source instead of a
          // boolean serif switch. Preserve the old choice while dropping the
          // retired field from persisted state.
          const { editorSerif: legacyEditorSerif, ...rest } = next;
          next = {
            ...rest,
            editorFontSource: legacyEditorSerif === false ? 'system-sans' : 'system-serif',
          };
        }
        if (version < 16) {
          // General Agent now runs in-process through the provider-neutral
          // runtime. P1 exposes the existing DeepSeek BYOK substrate and a
          // completion-mode tool loop; legacy Claude OAuth/model/thinking
          // selections are not valid inputs for this adapter.
          next.agentAuth = 'apikey';
          if (typeof next.agentModel !== 'string' || !next.agentModel.startsWith('deepseek-')) {
            next.agentModel = 'deepseek-v4-flash';
          }
          next.agentThinking = 'off';
          next.agentToolSearch = 'off';
        }
        if (version < 17) {
          // Typewriter scrolling is a device-local editor behavior, separate
          // from manuscript/Yjs data.
          next.typewriterMode = false;
          next.typewriterPosition = TYPEWRITER_POSITION_DEFAULT;
        }
        if (version < 18) {
          // Focus dimming was removed. Drop the obsolete persisted preference
          // instead of carrying an inert field indefinitely.
          const { focusLine: _omit, ...rest } = next;
          void _omit;
          next = rest;
        }
        if (version < 19) {
          next.caretColor = CARET_COLOR_DEFAULT;
        }
        if (version < 20) {
          // Earlier General Agent builds persisted `off` as their default, so
          // merely changing the fresh-store value would leave every existing
          // installation on the 30-schema path. Migrate once to bounded Auto;
          // users can explicitly choose Off again after this upgrade.
          next.agentToolSearch = migrateAgentToolSearch(next.agentToolSearch, version);
        }
        if (version < 21) {
          next.entityLinkColorMode = 'contextual';
          next.entityLinkKindColors = { ...DEFAULT_ENTITY_LINK_KIND_COLORS };
        }
        if (version < 22) {
          const provider = normalizeAgentProvider(next.agentProvider);
          next.agentProvider = provider;
          next.agentModel = normalizeAgentProviderModel(provider, next.agentModel);
        }
        if (version < 23) {
          next.agentMaxContext = false;
        }
        if (version < 24) {
          const provider = normalizeAgentProvider(next.agentProvider);
          const model = normalizeAgentProviderModel(provider, next.agentModel);
          next.agentProvider = provider;
          next.agentModel = model;
          next.agentThinking = normalizeAgentProviderThinking(provider, model, next.agentThinking);
          next.agentEffort = normalizeAgentProviderEffort(provider, model, next.agentEffort);
        }
        if (version < 26) {
          next.outlineRailMode = OUTLINE_RAIL_MODE_DEFAULT;
        }
        if (version < 27) {
          const retired = next as unknown as Record<string, unknown>;
          for (const key of [
            'shadowAiMode',
            'shadowTier',
            'shadowByokProvider',
            'shadowByokModel',
            'shadowAutoRun',
            'shadowEditMode',
            'evolveEditorEngine',
          ]) {
            delete retired[key];
          }
        }
        return next;
      },
      // BYOK-only builds (VITE_BYOK_ONLY) disable the hosted AI tier — the server
      // carries no hosted key. Coerce any persisted 'hosted' to its BYOK equivalent
      // on EVERY load (migrate only fires on a version bump, which wouldn't catch an
      // already-migrated install), so a saved 'hosted' can never silently route to
      // the keyless server. Otherwise preserves the default shallow-merge semantics.
      merge: (persisted, current) => {
        const persistedSettings = persisted as Partial<SettingsState> | undefined;
        const merged = { ...current, ...persistedSettings };
        merged.agentProvider = normalizeAgentProvider(merged.agentProvider);
        merged.agentModel = normalizeAgentProviderModel(merged.agentProvider, merged.agentModel);
        merged.agentThinking = normalizeAgentProviderThinking(
          merged.agentProvider,
          merged.agentModel,
          merged.agentThinking,
        );
        merged.agentEffort = normalizeAgentProviderEffort(
          merged.agentProvider,
          merged.agentModel,
          merged.agentEffort,
        );
        merged.agentMaxContext = merged.agentMaxContext === true;
        merged.agentToolSearch = normalizeAgentToolSearch(persistedSettings?.agentToolSearch);
        if (APP_CONFIG.BYOK_ONLY) {
          if (merged.copilotAiMode === 'hosted') merged.copilotAiMode = 'byok';
          if (merged.agentAuth === 'hosted') merged.agentAuth = 'apikey';
        }
        const retired = merged as unknown as Record<string, unknown>;
        for (const key of [
          'shadowAiMode',
          'shadowTier',
          'shadowByokProvider',
          'shadowByokModel',
          'shadowAutoRun',
          'shadowEditMode',
          'evolveEditorEngine',
        ]) {
          delete retired[key];
        }
        if (
          merged.editorFontSource !== 'system-serif' &&
          merged.editorFontSource !== 'system-sans' &&
          merged.editorFontSource !== 'system-mono' &&
          merged.editorFontSource !== 'system-custom' &&
          merged.editorFontSource !== 'imported'
        ) {
          merged.editorFontSource = EDITOR_STYLE_DEFAULTS.editorFontSource;
        }
        merged.editorSystemFontFamily =
          typeof merged.editorSystemFontFamily === 'string'
            ? merged.editorSystemFontFamily.trim().slice(0, 128)
            : '';
        if (merged.editorFontSource === 'system-custom' && !merged.editorSystemFontFamily) {
          merged.editorFontSource = EDITOR_STYLE_DEFAULTS.editorFontSource;
        }
        merged.typewriterMode = merged.typewriterMode === true;
        merged.typewriterPosition = clamp(
          merged.typewriterPosition,
          TYPEWRITER_POSITION_MIN,
          TYPEWRITER_POSITION_MAX,
          TYPEWRITER_POSITION_DEFAULT,
        );
        merged.caretColor = normalizeCaretColor(merged.caretColor);
        delete (merged as unknown as Record<string, unknown>).outlineRailVisible;
        merged.outlineRailMode = normalizeOutlineRailMode(merged.outlineRailMode);
        merged.entityLinkColorMode = normalizeEntityLinkColorMode(merged.entityLinkColorMode);
        merged.entityLinkKindColors = normalizeEntityLinkKindColors(merged.entityLinkKindColors);
        return merged;
      },
    },
  ),
);
