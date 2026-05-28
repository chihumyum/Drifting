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
import { buildBaseBlockContext } from '../copilot/base-block-context';
import {
  clearLogBuffer,
  getLogEntryById,
  getRecentLogEntries,
  type AIRequestLogEntry,
} from './log/request-log';
import { filenameForEntry, formatEntryAsMarkdown } from './log/markdown-format';

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
   * Copilot dev surface. `detectAtCursor()` runs element-candidate detection
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
  /**
   * AI request/response log. Browse the ring buffer from DevTools and open
   * the markdown-files directory in Finder. Capture is enabled only in DEV
   * builds (see build-default-client.ts).
   */
  log: {
    /** Latest N entries, newest first. Default 20. */
    recent(limit?: number): AIRequestLogEntry[];
    /** Most recent entry shorthand. */
    last(): AIRequestLogEntry | undefined;
    /** Look up by request id (shown as `Request ID` in the markdown files). */
    byId(id: string): AIRequestLogEntry | undefined;
    /** Print a single entry to console with `\n` expanded for easy reading. */
    print(idOrEntry?: string | AIRequestLogEntry): void;
    /** Dump the latest entry's markdown to the clipboard. */
    copyLastMarkdown(): Promise<void>;
    /** Open the userData/ai-log/ directory in Finder / Explorer. */
    openDir(): Promise<string>;
    /** Print the path of the log directory. */
    dir(): Promise<string>;
    /** Wipe the in-memory ring buffer. Files on disk are not touched. */
    clear(): void;
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
    log: {
      recent: (limit = 20) => getRecentLogEntries(limit),
      last: () => getRecentLogEntries(1)[0],
      byId: (id) => getLogEntryById(id),
      print: (idOrEntry) => {
        const entry =
          typeof idOrEntry === 'string'
            ? getLogEntryById(idOrEntry)
            : (idOrEntry ?? getRecentLogEntries(1)[0]);
        if (!entry) {
          console.info('[ai-log] no entry');
          return;
        }
        // Re-emit as a Markdown string. console.log expands real newlines,
        // so the user gets a properly-wrapped read in DevTools too.
        console.log(formatEntryAsMarkdown(entry));
      },
      copyLastMarkdown: async () => {
        const entry = getRecentLogEntries(1)[0];
        if (!entry) {
          console.info('[ai-log] no entry to copy');
          return;
        }
        const md = formatEntryAsMarkdown(entry);
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(md);
          console.info(`[ai-log] copied ${filenameForEntry(entry)} to clipboard`);
        } else {
          console.warn('[ai-log] clipboard API unavailable; logging instead');
          console.log(md);
        }
      },
      openDir: async () => {
        const api = window.electronAPI?.aiLog;
        if (!api) throw new Error('aiLog IPC not available (non-Electron env?)');
        return api.openDir();
      },
      dir: async () => {
        const api = window.electronAPI?.aiLog;
        if (!api) throw new Error('aiLog IPC not available (non-Electron env?)');
        const path = await api.getDir();
        console.info(`[ai-log] ${path}`);
        return path;
      },
      clear: () => clearLogBuffer(),
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

        // Dev console doesn't track which chapter the active editor is in.
        // Use a synthetic chapterId so coverage-map finds zero existing
        // sections (priorSections will be empty) — capabilities still see
        // every non-empty block in the editor as "uncovered" and scan them.
        // For real chapter-context behavior, drive Copilot via the actual
        // editor mount, not this dev surface.
        const baseContext = await buildBaseBlockContext({
          editor,
          chapterId: '__dev__',
        });
        if (!baseContext) {
          throw new Error(
            `Coverage map produced no uncovered blocks — editor is empty? ` +
              `(blockId hint was ${blockId.slice(0, 8)}.)`,
          );
        }

        const controller = new AbortController();
        const all: CapabilityDetectResult[] = [];
        for (const cap of caps) {
          const results = await cap.detect({
            runtime: copilotRuntime,
            editor,
            projectId,
            targetKind: 'node',
            targetId: '',
            baseContext,
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
      `  await window.__driftingAI.copilot.detectAtCursor()\n` +
      `  window.__driftingAI.log.print()       // last request as markdown\n` +
      `  await window.__driftingAI.log.openDir()  // open ai-log/ in Finder`,
  );
}
