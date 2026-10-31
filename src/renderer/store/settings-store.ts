import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { AgentEffortChoice } from '../lib/agent/protocol';
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
import { normalizeAccentColor } from '../lib/theme';
import { normalizeInterfaceTextSize, type InterfaceTextSize } from '../lib/interface-typography';
import {
  DEFAULT_ENTITY_LINK_KIND_COLORS,
  normalizeEntityLinkBandStyle,
  normalizeEntityLinkColorMode,
  normalizeEntityLinkHexColor,
  normalizeEntityLinkHighlightMode,
  normalizeEntityLinkKindColors,
  type EntityLinkColorKind,
  type EntityLinkBandStyle,
  type EntityLinkColorMode,
  type EntityLinkHighlightMode,
  type EntityLinkKindColors,
} from '../lib/entity-link-appearance';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ParagraphIndent = 'none' | 'one' | 'two';
export type EditorTextWrap = 'stable' | 'pretty';
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
export type OutlineRailMode = 'visible' | 'hidden';
export const OUTLINE_RAIL_MODE_DEFAULT: OutlineRailMode = 'visible';

export function normalizeOutlineRailMode(value: unknown): OutlineRailMode {
  if (value === 'hidden') return 'hidden';
  // `always` and `auto` are persisted by the retired dual-scrollbar modes.
  // Both now mean that the independent left TOC rail is visible.
  if (value === 'visible' || value === 'always' || value === 'auto') return 'visible';
  return OUTLINE_RAIL_MODE_DEFAULT;
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
  editorTextWrap: 'stable',
} satisfies {
  editorFontSource: EditorFontSource;
  bodyFontSize: number;
  lineHeight: LineHeight;
  paragraphIndent: ParagraphIndent;
  editorIndentStep: number;
  paragraphSpacing: number;
  maxLineWidth: number;
  editorTextWrap: EditorTextWrap;
};

export function normalizeEditorTextWrap(value: unknown): EditorTextWrap {
  return value === 'pretty' ? 'pretty' : EDITOR_STYLE_DEFAULTS.editorTextWrap;
}
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
export type AgentEffort = AgentEffortChoice;
/** Extended-thinking mode: 'adaptive' = model decides; 'off' = disabled. */
export type AgentThinking = 'adaptive' | 'off';
/**
 * Provider-neutral runtime tool selection, consumed live by the product
 * composition's selection strategy (`drifting-product-tool-selection.ts`).
 *  - 'off':  expose the complete installed surface, stable per iteration
 *            (also the provider prefix-cache-friendly configuration).
 *  - 'auto': run bounded author-domain relevance selection when the installed
 *            surface exceeds the runtime auto threshold.
 *  - 'on':   always run the bounded relevance selector.
 */
export type AgentToolSearch = 'off' | 'auto' | 'on';

/** Product default for a fresh General Agent installation. */
export const AGENT_TOOL_SEARCH_DEFAULT: AgentToolSearch = 'auto';
export const SETTINGS_STORAGE_VERSION = 33;

/**
 * The Agent panel's first run (features/agent/onboarding): `new` until the
 * author sends from the panel, `change` until they open the first change, then
 * `done`. Settings → General Agent puts it back to `new`.
 */
export type AgentOnboardingStep = 'new' | 'change' | 'done';

/** An installation that predates the guide skips it if the Agent was already used here. */
export function agentOnboardingStepForExistingInstall(
  lastAgentConvByProject: Record<string, string> | undefined,
): AgentOnboardingStep {
  return lastAgentConvByProject && Object.keys(lastAgentConvByProject).length > 0 ? 'done' : 'new';
}

/** Persisted keys of the retired Copilot, dropped by the v32 migration. */
const RETIRED_COPILOT_SETTINGS = [
  'copilotTier',
  'copilotAiMode',
  'copilotByokProvider',
  'copilotByokModel',
  'copilotAutoTrigger',
  'copilotMode',
  'copilotInDrift',
  'copilotTasks',
  'copilotDebounceMs',
  'copilotTaskConfigs',
  'copilotGenerateSummaries',
  'copilotSummarySectionSize',
  'copilotInlineEditAllowNewContent',
  'copilotOutputLangByProject',
] as const;

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

/**
 * The v29 accent preference deliberately starts empty for older installations:
 * the retired localStorage picker did not contain a trustworthy value to adopt.
 */
export function migrateAccentColor(value: unknown, persistedVersion: number): string | null {
  return persistedVersion < 29 ? null : normalizeAccentColor(value);
}

/**
 * Hard per-turn brake on the Agent model-iteration loop. `null` means no cap
 * (the historical unlimited behavior); the runtime ends an over-limit turn as
 * `budget_exceeded` with durable progress preserved, so the author can send
 * another message to continue.
 */
export const AGENT_TURN_ITERATION_LIMIT_DEFAULT = 50;
export const AGENT_TURN_ITERATION_LIMIT_OPTIONS: readonly number[] = [25, 50, 100, 200];
const AGENT_TURN_ITERATION_LIMIT_MAX = 1_000;

export function normalizeAgentTurnIterationLimit(value: unknown): number | null {
  if (value === null) return null;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, AGENT_TURN_ITERATION_LIMIT_MAX)
    : AGENT_TURN_ITERATION_LIMIT_DEFAULT;
}

/** Tool-search options for the settings picker. */
export const AGENT_TOOL_SEARCH_OPTIONS: { value: AgentToolSearch; label: string }[] = [
  { value: 'off', label: 'Off · load all tools' },
  { value: 'auto', label: 'Auto · enable above threshold' },
  { value: 'on', label: 'On · force tool search' },
];
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
export type DateFormat = 'cjk' | 'iso' | 'us';

function normalizeUiLocale(locale: LocaleCode): LocaleCode {
  return locale.startsWith('zh') ? 'zh-CN' : 'en';
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
  /** Device-local desktop UI size, independent of manuscript preferences. */
  interfaceTextSize: InterfaceTextSize;
  setInterfaceTextSize: (size: InterfaceTextSize) => void;
  /** Null keeps the stylesheet-owned light/dark accent palette. */
  accentColor: string | null;
  setAccentColor: (color: string | null) => void;
  agentEditRevealAnimation: boolean;
  setAgentEditRevealAnimation: (enabled: boolean) => void;

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
  /** Device-local wrapping for authored text; does not change document content. */
  editorTextWrap: EditorTextWrap;
  setEditorTextWrap: (mode: EditorTextWrap) => void;
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
  entityLinkHighlightMode: EntityLinkHighlightMode;
  setEntityLinkHighlightMode: (mode: EntityLinkHighlightMode) => void;
  entityLinkBandStyle: EntityLinkBandStyle;
  setEntityLinkBandStyle: (style: EntityLinkBandStyle) => void;
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
  agentEffort: AgentEffort;
  setAgentEffort: (e: AgentEffort) => void;
  agentThinking: AgentThinking;
  setAgentThinking: (t: AgentThinking) => void;
  // Tool-search mode (ENABLE_TOOL_SEARCH). See AgentToolSearch.
  agentToolSearch: AgentToolSearch;
  setAgentToolSearch: (t: AgentToolSearch) => void;
  /**
   * Explicit author override for pre-execution destructive confirmations.
   * Certification, project isolation, freshness checks, receipts and guarded
   * write execution remain mandatory when this is enabled.
   */
  agentAllowDangerousOperations: boolean;
  setAgentAllowDangerousOperations: (on: boolean) => void;
  /**
   * Per-turn model-iteration cap read at turn start; `null` disables the cap.
   * See AGENT_TURN_ITERATION_LIMIT_DEFAULT.
   */
  agentTurnIterationLimit: number | null;
  setAgentTurnIterationLimit: (limit: number | null) => void;
  /**
   * Last-active Agent conversation id per project. Persisted so the Agent panel
   * re-opens the session the user was in after a reload/restart (the transcript
   * itself lives in SQLite agent_conversation). Cleared when a conversation is
   * started fresh or deleted while active.
   */
  lastAgentConvByProject: Record<string, string>;
  setLastAgentConv: (projectId: string, convId: string) => void;
  agentOnboardingStep: AgentOnboardingStep;
  setAgentOnboardingStep: (step: AgentOnboardingStep) => void;
  clearLastAgentConv: (projectId: string) => void;
  clearProjectSettings: (projectId: string) => void;

  // Device-local snapshot history
  autoSnapshot: boolean;
  setAutoSnapshot: (on: boolean) => void;

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
      accentColor: null,
      interfaceTextSize: 'standard',
      setInterfaceTextSize: (size) => set({ interfaceTextSize: normalizeInterfaceTextSize(size) }),
      setAccentColor: (color) => set({ accentColor: normalizeAccentColor(color) }),
      agentEditRevealAnimation: true,
      setAgentEditRevealAnimation: (enabled) => set({ agentEditRevealAnimation: enabled }),

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
      editorTextWrap: EDITOR_STYLE_DEFAULTS.editorTextWrap,
      setEditorTextWrap: (mode) => set({ editorTextWrap: normalizeEditorTextWrap(mode) }),
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
      entityLinkHighlightMode: 'both',
      setEntityLinkHighlightMode: (mode) =>
        set({ entityLinkHighlightMode: normalizeEntityLinkHighlightMode(mode) }),
      entityLinkBandStyle: 'wash',
      setEntityLinkBandStyle: (style) =>
        set({ entityLinkBandStyle: normalizeEntityLinkBandStyle(style) }),
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
      agentAllowDangerousOperations: false,
      setAgentAllowDangerousOperations: (on) => set({ agentAllowDangerousOperations: on }),
      agentTurnIterationLimit: AGENT_TURN_ITERATION_LIMIT_DEFAULT,
      setAgentTurnIterationLimit: (limit) =>
        set({ agentTurnIterationLimit: normalizeAgentTurnIterationLimit(limit) }),
      agentOnboardingStep: 'new',
      setAgentOnboardingStep: (step) => set({ agentOnboardingStep: step }),
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
      clearProjectSettings: (projectId) =>
        set((state) => {
          const lastAgentConvByProject = { ...state.lastAgentConvByProject };
          delete lastAgentConvByProject[projectId];
          return { lastAgentConvByProject };
        }),

      autoSnapshot: true,
      setAutoSnapshot: (on) => set({ autoSnapshot: on }),

      improveModelsWithManuscripts: false,
      setImproveModelsWithManuscripts: (on) => set({ improveModelsWithManuscripts: on }),
      sendUsageStats: false,
      setSendUsageStats: (on) => set({ sendUsageStats: on }),
      // Content-free crash and integrity reports; see services/diagnostics/crash-reporter.ts.
      sendCrashLogs: true,
      setSendCrashLogs: (on) => set({ sendCrashLogs: on }),
    }),
    {
      name: 'settings-storage',
      storage: createJSONStorage(() => localStorage),
      version: SETTINGS_STORAGE_VERSION,
      migrate: (persistedState, version) => {
        const state = persistedState as Partial<SettingsState> & {
          appearanceSkin?: 'classic' | 'modern';
          manuscriptSans?: boolean;
          editorSerif?: boolean;
          marginNotes?: boolean;
          marginNotesByKind?: unknown;
          animationsEnabled?: boolean;
          // v8→v9 legacy AI key (mapped to agentAuth below).
          agentMode?: 'hosted' | 'byok';
          focusLine?: unknown;
        };
        let next: Partial<SettingsState> & {
          appearanceSkin?: 'classic' | 'modern';
          manuscriptSans?: boolean;
          editorSerif?: boolean;
          marginNotes?: boolean;
          marginNotesByKind?: unknown;
          animationsEnabled?: boolean;
          agentMode?: 'hosted' | 'byok';
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
        if (version < 9) {
          // AI settings reorg by subsystem. `agentMode` (binary hosted/byok-
          // OAuth) becomes the 3-way `agentAuth` — BYOK now splits into 'oauth'
          // and 'apikey'. The never-wired Shadow scaffolding (orb/surface/
          // notify/permissions/voice/prompt) is dropped; no runtime ever
          // consumed it. The retired Copilot fields are dropped at v32.
          const legacy = next;
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
        if (version < 28) {
          next.agentAllowDangerousOperations = false;
        }
        next.accentColor = migrateAccentColor(next.accentColor, version);
        if (version < 30) {
          // Earlier builds ran the model-iteration loop unbounded. Give every
          // existing installation the bounded default once; the author can
          // explicitly choose unlimited again in Settings → Agent.
          next.agentTurnIterationLimit = AGENT_TURN_ITERATION_LIMIT_DEFAULT;
        }
        if (version < 31) {
          // The crash-log toggle was a disabled placeholder before reports
          // existed, so no stored value reflects a choice. Start enabled.
          next.sendCrashLogs = true;
        }
        if (version < 32) {
          // Copilot was retired in favour of the Agent.
          const retired = next as unknown as Record<string, unknown>;
          for (const key of RETIRED_COPILOT_SETTINGS) delete retired[key];
        }
        if (version < 33) {
          next.agentOnboardingStep = agentOnboardingStepForExistingInstall(next.lastAgentConvByProject);
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
        // Retire the product context cap even for same-version persisted settings.
        delete (merged as unknown as Record<string, unknown>).agentMaxContext;
        delete (merged as unknown as Record<string, unknown>).agentEditMode;
        merged.agentToolSearch = normalizeAgentToolSearch(persistedSettings?.agentToolSearch);
        merged.agentAllowDangerousOperations =
          persistedSettings?.agentAllowDangerousOperations === true;
        merged.agentTurnIterationLimit = normalizeAgentTurnIterationLimit(
          merged.agentTurnIterationLimit,
        );
        merged.accentColor = normalizeAccentColor(merged.accentColor);
        merged.interfaceTextSize = normalizeInterfaceTextSize(merged.interfaceTextSize);
        merged.editorTextWrap = normalizeEditorTextWrap(merged.editorTextWrap);
        merged.agentEditRevealAnimation = merged.agentEditRevealAnimation !== false;
        if (!['new', 'change', 'done'].includes(merged.agentOnboardingStep)) merged.agentOnboardingStep = 'new';
        if (APP_CONFIG.BYOK_ONLY) {
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
        merged.entityLinkHighlightMode = normalizeEntityLinkHighlightMode(merged.entityLinkHighlightMode);
        merged.entityLinkBandStyle = normalizeEntityLinkBandStyle(merged.entityLinkBandStyle);
        merged.entityLinkKindColors = normalizeEntityLinkKindColors(merged.entityLinkKindColors);
        return merged;
      },
    },
  ),
);
