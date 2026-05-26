/**
 * Dev console — mounts `window.__driftingAI` in development so we can
 * smoke-test the substrate from DevTools without UI.
 *
 * Credentials are resolved by a chain: **env first, keychain second**. So if
 * you set `VITE_GOOGLE_AI_API_KEY` in `.env.local`, `hello()` just works.
 * Otherwise, set the key once via the keychain and it's persisted:
 *
 *   // option A — env (recommended for dev): put in .env.local
 *   //   VITE_GOOGLE_AI_API_KEY=AIza...
 *
 *   // option B — keychain:
 *   await window.__driftingAI.setKey('AIza...')
 *
 *   // either way:
 *   await window.__driftingAI.hello('Yang')
 *   // → { greeting: '你好，Yang！', language: 'zh' }
 *
 * Only mounted under `import.meta.env.DEV`; production builds never see this
 * namespace. The substrate itself does not depend on this file.
 */
import { byokKeychain } from '../byok-keychain';
import { LLMClient } from './client/llm-client';
import { GoogleAIStudioProvider } from './client/providers/google';
import { BYOKCredentialsProvider } from './credentials/byok';
import { EnvCredentialsProvider } from './credentials/env';
import { ChainCredentialsProvider } from './credentials/chain';
import { LoggingInterceptor } from './interceptors/logging-interceptor';
import { helloWorldPrompt } from './prompts/templates/hello-world';
import { testToolPrompt } from './prompts/templates/test-tool';
import { callStructured } from './call-structured';

export interface DriftingAIDevConsole {
  setKey(apiKey: string): Promise<boolean>;
  clearKey(): Promise<boolean>;
  hasKey(): Promise<boolean>;
  hello(name: string): Promise<{ greeting: string; language: string }>;
  /**
   * Tool-call stress test. Exercises optional fields, integer constraints,
   * arrays, and nested objects. Default bio is provided for convenience.
   */
  testTool(bio?: string): Promise<{
    name: string;
    age?: number;
    occupation: string;
    hobbies: string[];
    location?: { city: string; country: string };
  }>;
}

declare global {
  interface Window {
    __driftingAI?: DriftingAIDevConsole;
  }
}

export function installAIDevConsole(): void {
  if (typeof window === 'undefined') return;
  if (!import.meta.env.DEV) return;
  if (window.__driftingAI) return; // already installed (HMR)

  const credentials = new ChainCredentialsProvider([
    new EnvCredentialsProvider(),
    new BYOKCredentialsProvider(),
  ]);

  async function buildClient(): Promise<LLMClient> {
    const apiKey = await credentials.getApiKey('google');
    const provider = new GoogleAIStudioProvider({ apiKey });
    return new LLMClient(provider).use(new LoggingInterceptor('ai'));
  }

  window.__driftingAI = {
    setKey: (apiKey) => byokKeychain.set('google', apiKey),
    clearKey: () => byokKeychain.clear('google'),
    hasKey: async () => {
      try {
        await credentials.getApiKey('google');
        return true;
      } catch {
        return false;
      }
    },
    hello: async (name) => {
      const client = await buildClient();
      return callStructured(client, helloWorldPrompt, { name });
    },
    testTool: async (bio) => {
      const client = await buildClient();
      return callStructured(client, testToolPrompt, {
        bio:
          bio ??
          'Yang is a 28-year-old software engineer living in Seattle, USA. ' +
            'She enjoys rock climbing, photography, and reading sci-fi novels.',
      });
    },
  };

  const source = import.meta.env.VITE_GOOGLE_AI_API_KEY
    ? 'env'
    : import.meta.env.VITE_GEMINI_API_KEY
      ? 'env'
      : 'keychain';
  console.info(
    `[ai] Dev console ready (key source: ${source}). Try: window.__driftingAI.hello('Yang')`,
  );
}
