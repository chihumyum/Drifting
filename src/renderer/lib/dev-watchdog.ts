/**
 * Development-only renderer heartbeat for the native stall watchdog
 * (`src-tauri/src/dev_watchdog.rs`). The native side notices a silent renderer
 * and writes `logs/renderer-stalls.log`, even if the renderer never recovers.
 * This side adds what only the renderer can know once it runs again: how late
 * its timer was and which labelled work overlapped the stall.
 */
import { invoke } from '@tauri-apps/api/core';
import { getActiveEditor } from './active-editor';
import { devActivitiesBetween, openDevActivities } from './dev-activity';

/** Must match `HEARTBEAT_INTERVAL` in `src-tauri/src/dev_watchdog.rs`. */
export const BEAT_MS = 250;
export const STALL_MS = 1_000;
const MAX_SEND_FAILURES = 5;
const INPUT_EVENTS = [
  'keydown',
  'pointerdown',
  'wheel',
  'compositionstart',
  'compositionend',
  'paste',
  'drop',
] as const;

export interface DevWatchdogBeat {
  sessionId: string;
  active: boolean;
  utcOffsetMinutes: number;
  context: Record<string, unknown>;
  recovered?: Record<string, unknown>;
}

export interface DevWatchdogHost {
  send(beat: DevWatchdogBeat): Promise<unknown>;
  /** Monotonic milliseconds. */
  now(): number;
  /** Epoch milliseconds, shared with dev activity timestamps. */
  wallNow(): number;
  visible(): boolean;
  context(): Record<string, unknown>;
  inputTarget: EventTarget;
  visibilityTarget: EventTarget;
}

export function startDevWatchdog(
  host: DevWatchdogHost,
  sessionId: string = crypto.randomUUID(),
): () => void {
  let lastTickAt = host.now();
  let lastInput: { type: string; at: number } | null = null;
  let failures = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onInput = (event: Event) => {
    lastInput = { type: event.type, at: host.wallNow() };
  };
  const onVisibility = () => {
    // Hidden pages throttle timers; their late ticks are not stalls.
    lastTickAt = host.now();
    send();
  };

  const context = (): Record<string, unknown> => {
    const wallNow = host.wallNow();
    return {
      ...host.context(),
      lastInput: lastInput ? { type: lastInput.type, agoMs: wallNow - lastInput.at } : null,
      openActivities: openDevActivities(wallNow).map(({ label, detail, durationMs }) => ({
        label,
        ...(detail ? { detail } : {}),
        ageMs: durationMs,
      })),
    };
  };

  const describeStall = (blockedMs: number): Record<string, unknown> => {
    const to = host.wallNow();
    // The blocking work may have started any time after the previous tick.
    const from = to - blockedMs - BEAT_MS;
    return {
      blockedMs,
      lastInput: lastInput
        ? { type: lastInput.type, msAfterPreviousTick: lastInput.at - from }
        : null,
      activities: devActivitiesBetween(from, to).map(({ label, detail, startedAt, durationMs, open }) => ({
        label,
        ...(detail ? { detail } : {}),
        msAfterPreviousTick: startedAt - from,
        durationMs,
        open,
      })),
    };
  };

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    for (const type of INPUT_EVENTS) host.inputTarget.removeEventListener(type, onInput, true);
    host.visibilityTarget.removeEventListener('visibilitychange', onVisibility);
  }

  function send(recovered?: Record<string, unknown>): void {
    if (stopped) return;
    const beat: DevWatchdogBeat = {
      sessionId,
      active: host.visible(),
      utcOffsetMinutes: -new Date(host.wallNow()).getTimezoneOffset(),
      context: context(),
      ...(recovered ? { recovered } : {}),
    };
    host.send(beat).then(
      () => {
        failures = 0;
      },
      (error: unknown) => {
        failures += 1;
        if (failures < MAX_SEND_FAILURES || stopped) return;
        stop();
        console.warn('[dev-watchdog] heartbeat disabled after repeated failures:', error);
      },
    );
  }

  const tick = () => {
    timer = setTimeout(tick, BEAT_MS);
    const now = host.now();
    const blockedMs = Math.round(now - lastTickAt - BEAT_MS);
    lastTickAt = now;
    send(blockedMs >= STALL_MS && host.visible() ? describeStall(blockedMs) : undefined);
  };

  for (const type of INPUT_EVENTS) {
    host.inputTarget.addEventListener(type, onInput, { capture: true, passive: true });
  }
  host.visibilityTarget.addEventListener('visibilitychange', onVisibility);
  send();
  timer = setTimeout(tick, BEAT_MS);
  return stop;
}

function browserContext(): Record<string, unknown> {
  let editor: Record<string, unknown> | null = null;
  try {
    const active = getActiveEditor();
    if (active) {
      editor = { docSize: active.state.doc.content.size, composing: active.view.composing };
    }
  } catch {
    editor = { unavailable: true };
  }
  return {
    route: location.hash || location.pathname,
    focused: document.hasFocus(),
    editor,
  };
}

const INSTALLED = '__DRIFTING_DEV_WATCHDOG__';

export function installDevWatchdog(): () => void {
  const global = window as unknown as Record<string, unknown>;
  if (global[INSTALLED]) return () => undefined;
  global[INSTALLED] = true;
  const stop = startDevWatchdog({
    send: (beat) => invoke('dev_watchdog_heartbeat', { beat }),
    now: () => performance.now(),
    wallNow: () => Date.now(),
    visible: () => document.visibilityState === 'visible',
    context: browserContext,
    inputTarget: window,
    visibilityTarget: document,
  });
  return () => {
    stop();
    delete global[INSTALLED];
  };
}
