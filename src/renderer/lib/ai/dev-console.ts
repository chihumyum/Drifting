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
import { buildDefaultLLMClient } from './client/build-default-client';
import { helloWorldPrompt } from './prompts/templates/hello-world';
import { testToolPrompt } from './prompts/templates/test-tool';
import { callStructured } from './call-structured';
import { getActiveEditor } from '../active-editor';
import { useProjectStore } from '../../store/project-store';
import { getBlockIdAtCursor } from './context/selectors/block-context';
import {
  capabilitiesForTrigger,
  getCopilotCapability,
  type CapabilityDetectResult,
} from '../copilot/capability';
import { copilotRuntime } from '../copilot/runtime';

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
  /**
   * Copilot dev surface. `detectAtCursor()` runs entity-candidate detection
   * on the cursor's current block and prints the filtered candidates WITHOUT
   * persisting — useful for inspecting prompt quality without spamming the
   * margin rail.
   */
  copilot: {
    detectAtCursor(): Promise<CapabilityDetectResult[]>;
    detectAtBlock(blockId: string, capabilityId?: string): Promise<CapabilityDetectResult[]>;
    /** List registered capability ids. */
    list(): string[];
  };
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

  window.__driftingAI = {
    setKey: (apiKey) => byokKeychain.set('google', apiKey),
    clearKey: () => byokKeychain.clear('google'),
    hasKey: async () => {
      try {
        await buildDefaultLLMClient();
        return true;
      } catch {
        return false;
      }
    },
    hello: async (name) => {
      const client = await buildDefaultLLMClient();
      return callStructured(client, helloWorldPrompt, { name });
    },
    testTool: async (bio) => {
      const client = await buildDefaultLLMClient();
      return callStructured(client, testToolPrompt, {
        bio:
          bio ??
          'Yang is a 28-year-old software engineer living in Seattle, USA. ' +
            'She enjoys rock climbing, photography, and reading sci-fi novels.',
      });
    },
    copilot: {
      list: () => capabilitiesForTrigger('editor-block-debounced').map((c) => c.id),
      async detectAtCursor() {
        const editor = getActiveEditor();
        if (!editor) throw new Error('No active editor. Click into a chapter first.');
        const blockId = getBlockIdAtCursor(editor);
        if (!blockId) throw new Error('Cursor is not inside an anchored block.');
        return this.detectAtBlock(blockId);
      },
      async detectAtBlock(blockId, capabilityId) {
        const editor = getActiveEditor();
        if (!editor) throw new Error('No active editor.');
        const projectId = useProjectStore.getState().currentProject?.id;
        if (!projectId) throw new Error('No current project.');

        // If a specific capability id was passed, run only that one. Otherwise
        // dispatch to every editor-block-debounced capability and merge.
        const caps = capabilityId
          ? [getCopilotCapability(capabilityId)].filter(
              (c): c is NonNullable<typeof c> => Boolean(c),
            )
          : capabilitiesForTrigger('editor-block-debounced');
        if (caps.length === 0) {
          throw new Error(
            capabilityId
              ? `No capability registered with id "${capabilityId}".`
              : 'No editor-block-debounced capabilities registered.',
          );
        }

        const controller = new AbortController();
        const all: CapabilityDetectResult[] = [];
        for (const cap of caps) {
          // Dev-console doesn't have nodeId at hand; pass empty string —
          // capabilities that need it should already operate off editor+blockId
          // for detect (targetId is only used by the runner for persistence).
          const results = await cap.detect({
            runtime: copilotRuntime,
            editor,
            projectId,
            targetKind: 'node',
            targetId: '',
            focusBlockId: blockId,
            signal: controller.signal,
          });
          all.push(...results);
        }
        return all;
      },
    },
  };

  const source = import.meta.env.VITE_GOOGLE_AI_API_KEY
    ? 'env'
    : import.meta.env.VITE_GEMINI_API_KEY
      ? 'env'
      : 'keychain';
  console.info(
    `[ai] Dev console ready (key source: ${source}). Try:\n` +
      `  await window.__driftingAI.hello('Yang')\n` +
      `  await window.__driftingAI.copilot.detectAtCursor()`,
  );
}
