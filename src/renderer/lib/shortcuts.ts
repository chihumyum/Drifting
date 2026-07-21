// Cross-platform keyboard shortcut helpers. Accelerator strings use `Mod` to
// mean Cmd on macOS / Ctrl elsewhere, plus optional `Shift`, `Alt`, `Ctrl`
// modifiers. Examples: "Mod+W", "Mod+Shift+F", "Alt+ArrowLeft".

import { getPlatformRuntime } from '../platform/runtime';

function usesAppleShortcuts(): boolean {
  const platform = getPlatformRuntime().nativePlatform;
  return platform === 'macos' || platform === 'ios';
}

export interface ParsedAccelerator {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  key: string; // normalized; matched case-insensitively against KeyboardEvent.key
}

export function parseAccelerator(accelerator: string): ParsedAccelerator | null {
  const parts = accelerator
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;

  let mod = false;
  let shift = false;
  let alt = false;
  let ctrl = false;
  let key = '';

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'mod' || lower === 'cmd' || lower === 'meta') mod = true;
    else if (lower === 'ctrl' || lower === 'control') ctrl = true;
    else if (lower === 'shift') shift = true;
    else if (lower === 'alt' || lower === 'option') alt = true;
    else key = part;
  }

  if (!key) return null;
  return { mod, shift, alt, ctrl, key };
}

export function matchesAccelerator(event: KeyboardEvent, accelerator: string): boolean {
  const parsed = parseAccelerator(accelerator);
  if (!parsed) return false;
  const isApple = usesAppleShortcuts();

  const wantMeta = isApple ? parsed.mod : false;
  const wantCtrl = isApple ? parsed.ctrl : parsed.mod || parsed.ctrl;

  if (event.metaKey !== wantMeta) return false;
  if (event.ctrlKey !== wantCtrl) return false;
  if (event.shiftKey !== parsed.shift) return false;
  if (event.altKey !== parsed.alt) return false;

  // Match by event.key (case-insensitive). Letters arrive lowercase unless
  // Shift is held; we normalize both sides.
  return event.key.toLowerCase() === parsed.key.toLowerCase();
}

const KEY_GLYPHS: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Enter: '⏎',
  Tab: '⇥',
  Backspace: '⌫',
  Escape: 'Esc',
};

export function formatAccelerator(accelerator: string): string {
  const parsed = parseAccelerator(accelerator);
  if (!parsed) return accelerator;
  const isApple = usesAppleShortcuts();
  const parts: string[] = [];
  if (parsed.mod) parts.push(isApple ? '⌘' : 'Ctrl');
  if (parsed.ctrl && !parsed.mod) parts.push('Ctrl');
  if (parsed.alt) parts.push(isApple ? '⌥' : 'Alt');
  if (parsed.shift) parts.push(isApple ? '⇧' : 'Shift');
  const keyDisplay =
    KEY_GLYPHS[parsed.key] ?? (parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key);
  parts.push(keyDisplay);
  return parts.join(isApple ? '' : '+');
}

// Reverse: build an accelerator string from a live keyboard event. Used by the
// shortcut recorder UI. Returns null if the user only pressed a modifier.
export function acceleratorFromEvent(event: KeyboardEvent): string | null {
  const key = event.key;
  if (!key || key === 'Meta' || key === 'Control' || key === 'Shift' || key === 'Alt') {
    return null;
  }
  const isApple = usesAppleShortcuts();
  const parts: string[] = [];
  if (isApple ? event.metaKey : event.ctrlKey) parts.push('Mod');
  if (isApple && event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  const normalized = key.length === 1 ? key.toUpperCase() : key;
  parts.push(normalized);
  return parts.join('+');
}
