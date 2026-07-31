/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
  readonly VITE_API_URL: string;
  readonly VITE_LOCAL_ONLY_MODE?: string;
  readonly VITE_ENABLE_SYNC?: string;
  readonly VITE_REQUIRE_AUTH?: string;
  readonly VITE_DEV_SESSION_STORAGE?: 'local' | 'keychain';
  // AI substrate (dev convenience — never ship a production build with these set)
  readonly VITE_GOOGLE_AI_API_KEY?: string;
  readonly VITE_GEMINI_API_KEY?: string;
  readonly VITE_ANTHROPIC_API_KEY?: string;
  readonly VITE_OPENAI_API_KEY?: string;
  readonly VITE_DEEPSEEK_AI_API_KEY?: string;
  readonly VITE_DEEPSEEK_API_KEY?: string;
  /** DEV-only loopback broker for structured General Agent smoke tests. */
  readonly VITE_DRIFTING_AGENT_DEBUG_URL?: string;
  /** DEV-only project route claimed by the Agent debug renderer. */
  readonly VITE_DRIFTING_AGENT_DEBUG_PROJECT_ID?: string;
  /** DEV-only reduced context window for forcing compaction in headless tests. */
  readonly VITE_DRIFTING_AGENT_DEBUG_CONTEXT_WINDOW_TOKENS?: string;
  /** DEV-only read-result cap for forcing durable result paging. */
  readonly VITE_DRIFTING_AGENT_DEBUG_RESULT_BUDGET_CHARS?: string;
  /** DEV-only turn-slice cap for exercising durable automatic continuation. */
  readonly VITE_DRIFTING_AGENT_DEBUG_MAX_MODEL_ITERATIONS?: string;
  /**
   * DeepSeek thinking-mode toggle. Set to "enabled" / "1" / "true" / "on"
   * to turn on thinking mode for the DeepSeek provider. Default OFF —
   * thinking mode is incompatible with forced tool_choice, which all
   * callStructured-based capabilities rely on.
   */
  readonly VITE_DEEPSEEK_THINKING?: string;
  /** Optional reasoning effort when thinking is enabled: 'high' | 'max'. Default 'high'. */
  readonly VITE_DEEPSEEK_REASONING_EFFORT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
