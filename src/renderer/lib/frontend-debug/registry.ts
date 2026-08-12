import { getPlatformRuntime } from '../../platform/runtime';
import type { FrontendDebugRegistryApi } from './types';

const MAX_STRING_CHARS = 1_024;
const SENSITIVE_KEY = /authorization|cookie|password|passwd|secret|api[-_]?key|token|byok/i;
const PROSE_KEY = /contentJson|prose|manuscript|documentHtml|rawHtml/i;
const slices = new Map<string, Map<symbol, () => unknown>>();

function sanitize(value: unknown, key = '', depth = 0): unknown {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (PROSE_KEY.test(key)) return '[OMITTED_PROSE]';
  if (depth > 8) return '[MAX_DEPTH]';
  if (typeof value === 'string') {
    return value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}…` : value;
  }
  if (Array.isArray(value))
    return value.slice(0, 500).map((item) => sanitize(item, key, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
        childKey,
        sanitize(child, childKey, depth + 1),
      ]),
    );
  }
  return value;
}

function selectionSnapshot() {
  const selection = window.getSelection();
  if (!selection) return null;
  return {
    collapsed: selection.isCollapsed,
    rangeCount: selection.rangeCount,
    anchorOffset: selection.anchorOffset,
    focusOffset: selection.focusOffset,
  };
}

function activeElementSnapshot() {
  const element = document.activeElement;
  if (!(element instanceof HTMLElement)) return null;
  return {
    tag: element.tagName.toLowerCase(),
    id: element.id || null,
    debugId: element.dataset.debugId ?? null,
    role: element.getAttribute('role'),
    ariaLabel: element.getAttribute('aria-label'),
    editable:
      element.isContentEditable ||
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement,
  };
}

function registrySnapshot() {
  const registered: Record<string, unknown> = {};
  for (const [name, registrations] of slices) {
    const getters = [...registrations.values()];
    const getter = getters[getters.length - 1];
    if (!getter) continue;
    try {
      registered[name] = sanitize(getter(), name);
    } catch (error) {
      registered[name] = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const viewport = window.visualViewport;
  return {
    capturedAt: new Date().toISOString(),
    route: `${location.pathname}${location.hash}`,
    runtime: sanitize(getPlatformRuntime()),
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      visualViewport: viewport
        ? {
            width: viewport.width,
            height: viewport.height,
            offsetLeft: viewport.offsetLeft,
            offsetTop: viewport.offsetTop,
            scale: viewport.scale,
          }
        : null,
    },
    focus: activeElementSnapshot(),
    selection: selectionSnapshot(),
    slices: registered,
  };
}

export function installFrontendDebugRegistry(): FrontendDebugRegistryApi {
  const existing = window.__DRIFTING_FRONTEND_DEBUG_V1__;
  if (existing) return existing;
  const api = Object.freeze({ version: 1 as const, snapshot: registrySnapshot });
  Object.defineProperty(window, '__DRIFTING_FRONTEND_DEBUG_V1__', {
    value: api,
    configurable: true,
    enumerable: false,
    writable: false,
  });
  return api;
}

export function registerFrontendDebugSlice(name: string, getSnapshot: () => unknown): () => void {
  const token = Symbol(name);
  const registrations = slices.get(name) ?? new Map<symbol, () => unknown>();
  registrations.set(token, getSnapshot);
  slices.set(name, registrations);
  return () => {
    const current = slices.get(name);
    current?.delete(token);
    if (current?.size === 0) slices.delete(name);
  };
}
