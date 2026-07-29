import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { BYOKProvider } from '../lib/byok-keychain';
import { APP_CONFIG } from '../lib/config';

export type ThemeMode = 'light' | 'dark' | 'system';
export type FocusLineMode = 'off' | 'paragraph' | 'line' | 'sentence';
export type ParagraphIndent = 'none' | 'one' | 'two';
export type EditorFontSource =
  | 'system-serif'
  | 'system-sans'
  | 'system-custom'
  | 'imported';
/** Editor line height, a free ratio in [1.0, 2.0] (slider, clamped on set). */
export type LineHeight = number;

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
 * General-Agent (Claude Agent SDK) credential method. Unlike copilot's binary
 * hosted/BYOK, the Agent SDK speaks Claude only, so BYOK splits into two:
 *  - 'hosted': route through Drifting's metered proxy (subscription).
 *  - 'oauth':  the user's Claude account via OAuth (Max/Pro) — direct, unmetered.
 *  - 'apikey': a plain Anthropic API key (pay-as-you-go), stored in the keychain
 *              as `byok.agent.anthropic`. The SDK reads it as ANTHROPIC_API_KEY.
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
 * Tool-search mode (SDK ENABLE_TOOL_SEARCH). The ~49 drifting MCP tools cost
 * ~10k tokens of definitions up front; tool search defers them and fetches only
 * the relevant 3–5 per turn.
 *  - 'off':  always load every tool definition (today's behaviour).
 *  - 'auto': SDK default — only kicks in when tool defs exceed ~10% of context;
 *            at 49 tools this rarely fires, so it's effectively 'off' for now.
 *  - 'on':   force on — use this to measure the input-token delta.
 * Needs Sonnet 4+/Opus 4+; not supported on Haiku.
 */
export type AgentToolSearch = 'off' | 'auto' | 'on';

/** Tool-search options for the settings picker. */
export const AGENT_TOOL_SEARCH_OPTIONS: { value: AgentToolSearch; label: string }[] = [
  { value: 'off', label: 'Off · load all tools' },
  { value: 'auto', label: 'Auto · enable above threshold' },
  { value: 'on', label: 'On · force tool search' },
];
/**
 * How the agent's prose edits surface in the editor:
 *  - 'auto':    edits apply silently; the editor shows colored scrollbar ticks
 *               and plays a reveal animation as each changed block scrolls in.
 *  - 'approve': each changed block gets inline accept/reject — approving plays
 *               the reveal animation, rejecting undoes the block via Yjs.
 * The change always lands in the doc first either way (soft approval).
 */
export type AgentEditMode = 'auto' | 'approve';

// Which engine drives /goal evolve's prose edits. 'agent-sdk' is retained only
// as a persisted-value/future-transport compatibility token; this Tauri build
// coerces it to the renderer-native, BYOK-compatible 'shadow-fc' engine.
export type EvolveEditorEngine = 'agent-sdk' | 'shadow-fc';

/**
 * The model picker's catalog (shared by Settings and the input-bar switcher).
 * `short` is the compact label for the narrow in-panel picker. Tier aliases
 * track the latest of each family; pinned ids name an exact version.
 */
export const AGENT_MODEL_OPTIONS: { value: string; label: string; short: string }[] = [
  {
    value: 'deepseek-v4-flash',
    label: 'DeepSeek Flash · fast',
    short: 'Flash',
  },
  {
    value: 'deepseek-v4-pro',
    label: 'DeepSeek Pro · steady',
    short: 'Pro',
  },
];

/** Effort levels for the pickers, with compact labels. */
export const AGENT_EFFORT_OPTIONS: { value: AgentEffort; label: string; short: string }[] = [
  { value: 'low', label: 'Low', short: 'Low' },
  { value: 'medium', label: 'Medium', short: 'Med' },
  { value: 'high', label: 'High', short: 'High' },
  { value: 'xhigh', label: 'X-High', short: 'XHigh' },
  { value: 'max', label: 'Max', short: 'Max' },
];
export type LocaleCode = 'zh-CN' | 'zh-TW' | 'en' | 'ja' | 'ko' | 'fr';
/** Per-project Copilot/Shadow output language. 'auto' = follow manuscriptLocale. */
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
  focusLine: FocusLineMode;
  setFocusLine: (mode: FocusLineMode) => void;
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

  // Shadow (影) provider config — governs BOTH chapter-CI review and element-arc
  // derivation. Independent of Copilot (deliberately its own slice, not a shared
  // field). Same shape as Copilot: hosted tier OR BYOK provider+model. The hosted
  // tier maps to a concrete model in lib/shadow/model-routing.ts (低 flash / 中 pro
  // / 高 sonnet); 高 (Sonnet) is server-routed (needs the hosted proxy).
  shadowAiMode: AiMode;
  setShadowAiMode: (m: AiMode) => void;
  shadowTier: ModelTier;
  setShadowTier: (t: ModelTier) => void;
  shadowByokProvider: BYOKProvider;
  setShadowByokProvider: (p: BYOKProvider) => void;
  shadowByokModel: string;
  setShadowByokModel: (m: string) => void;
  // When on, marking a chapter「已完成」auto-runs a shadow review first
  // (waiting_review → finished/draft). Off = mark finished directly, no review;
  // the user reviews by hand (复审 / 复审全书). Deps-change re-review is NEVER
  // automatic — it only surfaces as the「需复审」reminder (see useStaleReviews),
  // which the user can ignore or act on regardless of this toggle.
  shadowAutoRun: boolean;
  setShadowAutoRun: (on: boolean) => void;

  // General Agent (Claude Agent SDK) credential method — independent of copilot.
  // hosted = our metered proxy; oauth = user's Claude account; apikey = a plain
  // Anthropic API key (kept in the keychain). See AgentAuth.
  agentAuth: AgentAuth;
  setAgentAuth: (a: AgentAuth) => void;
  // General Agent (Claude Agent SDK) generation params — passed into query().
  agentModel: AgentModel;
  setAgentModel: (m: AgentModel) => void;
  agentEffort: AgentEffort;
  setAgentEffort: (e: AgentEffort) => void;
  agentThinking: AgentThinking;
  setAgentThinking: (t: AgentThinking) => void;
  // Tool-search mode (ENABLE_TOOL_SEARCH). See AgentToolSearch.
  agentToolSearch: AgentToolSearch;
  setAgentToolSearch: (t: AgentToolSearch) => void;
  // How the agent's prose edits surface (auto reveal vs manual approve). See AgentEditMode.
  agentEditMode: AgentEditMode;
  setAgentEditMode: (m: AgentEditMode) => void;
  // /goal evolve's OWN edit-surface mode (it's a Shadow-module op, not the general
  // agent) + which engine edits the prose. Kept separate from agentEditMode so the
  // general agent's preference doesn't govern a batch cross-chapter evolve.
  shadowEditMode: AgentEditMode;
  setShadowEditMode: (m: AgentEditMode) => void;
  evolveEditorEngine: EvolveEditorEngine;
  setEvolveEditorEngine: (e: EvolveEditorEngine) => void;

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
   * Per-project output language for Copilot (and future Shadow) generation,
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
      focusLine: 'paragraph',
      setFocusLine: (m) => set({ focusLine: m }),
      entityLinkInteractive: true,
      setEntityLinkInteractive: (on) => set({ entityLinkInteractive: on }),
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
      // Shadow defaults: hosted + 中档 (DeepSeek-Pro). Pro is the sensible default
      // for a quality-sensitive consistency judge / arc derive (steadier reasoning,
      // far fewer JSON-format failures than flash). Dial down to 低 for flash, or
      // switch to BYOK to pin your own model.
      shadowAiMode: 'byok',
      setShadowAiMode: () => set({ shadowAiMode: 'byok' }),
      shadowTier: 'standard',
      setShadowTier: (t) => set({ shadowTier: t }),
      shadowAutoRun: true,
      setShadowAutoRun: (on) => set({ shadowAutoRun: on }),
      shadowByokProvider: 'deepseek',
      setShadowByokProvider: (p) => set({ shadowByokProvider: p }),
      shadowByokModel: 'deepseek-v4-flash',
      setShadowByokModel: (m) => set({ shadowByokModel: m }),
      agentAuth: 'apikey',
      setAgentAuth: (auth) => set({ agentAuth: auth === 'hosted' ? 'apikey' : auth }),
      agentModel: 'deepseek-v4-flash',
      setAgentModel: (m) => set({ agentModel: m }),
      agentEffort: 'high',
      setAgentEffort: (e) => set({ agentEffort: e }),
      agentThinking: 'off',
      setAgentThinking: (t) => set({ agentThinking: t }),
      agentToolSearch: 'off',
      setAgentToolSearch: (t) => set({ agentToolSearch: t }),
      agentEditMode: 'auto',
      setAgentEditMode: (m) => set({ agentEditMode: m }),
      // Default 'approve': a batch cross-chapter evolve on a fallible critic warrants
      // explicit per-block review. Shadow-FC works on every supported Tauri target.
      shadowEditMode: 'approve',
      setShadowEditMode: (m) => set({ shadowEditMode: m }),
      evolveEditorEngine: 'shadow-fc',
      setEvolveEditorEngine: (e) => set({ evolveEditorEngine: e }),
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
      version: 16,
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
        if (version < 11) {
          // Shadow gets its own model-routing slice (was previously not wired —
          // review + arc used hardcoded model constants). Additive: the default
          // state supplies the values, but seed them explicitly so the field is
          // present even before any setter runs. Independent of Copilot by design.
          if (next.shadowAiMode === undefined) next.shadowAiMode = 'hosted';
          if (next.shadowTier === undefined) next.shadowTier = 'standard';
          if (next.shadowByokProvider === undefined) next.shadowByokProvider = 'deepseek';
          if (next.shadowByokModel === undefined) next.shadowByokModel = 'deepseek-v4-flash';
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
        if (version < 13) {
          // The desktop-only General Agent runtime was removed during the Tauri
          // migration. Keep evolve functional by moving every persisted engine
          // choice to the renderer-native Shadow function-calling editor.
          next.evolveEditorEngine = 'shadow-fc';
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
          if (
            typeof next.agentModel !== 'string' ||
            !next.agentModel.startsWith('deepseek-')
          ) {
            next.agentModel = 'deepseek-v4-flash';
          }
          next.agentThinking = 'off';
          next.agentToolSearch = 'off';
        }
        return next;
      },
      // BYOK-only builds (VITE_BYOK_ONLY) disable the hosted AI tier — the server
      // carries no hosted key. Coerce any persisted 'hosted' to its BYOK equivalent
      // on EVERY load (migrate only fires on a version bump, which wouldn't catch an
      // already-migrated install), so a saved 'hosted' can never silently route to
      // the keyless server. Otherwise preserves the default shallow-merge semantics.
      merge: (persisted, current) => {
        const merged = { ...current, ...(persisted as Partial<SettingsState>) };
        if (APP_CONFIG.BYOK_ONLY) {
          if (merged.copilotAiMode === 'hosted') merged.copilotAiMode = 'byok';
          if (merged.shadowAiMode === 'hosted') merged.shadowAiMode = 'byok';
          if (merged.agentAuth === 'hosted') merged.agentAuth = 'apikey';
        }
        // `merge` runs on every hydration, including stores already marked v14
        // or hand-edited values that bypassed the one-time migration.
        if (merged.evolveEditorEngine === 'agent-sdk') {
          merged.evolveEditorEngine = 'shadow-fc';
        }
        if (
          merged.editorFontSource !== 'system-serif' &&
          merged.editorFontSource !== 'system-sans' &&
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
        return merged;
      },
    },
  ),
);
