/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
  readonly VITE_API_URL: string;
  readonly VITE_LOCAL_ONLY_MODE?: string;
  readonly VITE_ENABLE_SYNC?: string;
  readonly VITE_REQUIRE_AUTH?: string;
  // AI substrate (dev convenience — never ship a production build with these set)
  readonly VITE_GOOGLE_AI_API_KEY?: string;
  readonly VITE_GEMINI_API_KEY?: string;
  readonly VITE_ANTHROPIC_API_KEY?: string;
  readonly VITE_OPENAI_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
