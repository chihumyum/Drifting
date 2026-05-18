import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type ThemeMode = 'light' | 'dark' | 'system';
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
  | 'entityExtract'
  | 'autoLink'
  | 'polish'
  | 'research';

export const COPILOT_TASKS: { id: CopilotTaskId; label: string; desc: string }[] = [
  { id: 'continuityCheck', label: '人物一致性核查', desc: '识别人物在不同章节的设定冲突' },
  { id: 'timelineAlign', label: '时间线对齐', desc: '对齐章节与时间线锚点' },
  { id: 'entityExtract', label: '实体抽取', desc: '从手稿中抽取人物 / 地点 / 物件' },
  { id: 'autoLink', label: '自动链接', desc: '把正文里出现的实体自动挂载到元素页面' },
  { id: 'polish', label: '语言润色', desc: '挑出生硬或重复的句式作为批注' },
  { id: 'research', label: '资料检索', desc: '联网核查史实、地理、风物等' },
];

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
  animationsEnabled: boolean;
  setAnimationsEnabled: (on: boolean) => void;

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
  marginNotes: boolean;
  setMarginNotes: (on: boolean) => void;
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
  copilotTasks: CopilotTaskId[];
  toggleCopilotTask: (id: CopilotTaskId) => void;
  setCopilotTasks: (ids: CopilotTaskId[]) => void;

  // 同步
  wifiOnlySync: boolean;
  setWifiOnlySync: (on: boolean) => void;
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
      animationsEnabled: true,
      setAnimationsEnabled: (on) => set({ animationsEnabled: on }),

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
      marginNotes: true,
      setMarginNotes: (on) => set({ marginNotes: on }),
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
      copilotTasks: ['continuityCheck', 'entityExtract', 'autoLink'],
      toggleCopilotTask: (id) =>
        set((state) => ({
          copilotTasks: state.copilotTasks.includes(id)
            ? state.copilotTasks.filter((t) => t !== id)
            : [...state.copilotTasks, id],
        })),
      setCopilotTasks: (ids) => set({ copilotTasks: ids }),

      wifiOnlySync: true,
      setWifiOnlySync: (on) => set({ wifiOnlySync: on }),
      autoSnapshot: true,
      setAutoSnapshot: (on) => set({ autoSnapshot: on }),

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
    },
  ),
);
