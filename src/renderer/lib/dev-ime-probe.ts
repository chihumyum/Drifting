/**
 * Development-only probe for the intermittent WebKit symptom where an open
 * pinyin composition becomes a selection (see
 * docs/renderer-performance/editor-ime-copilot.md).
 *
 * The probe attaches to whichever editor receives `compositionstart`. It
 * records composition, input, selection and focus events, editor transactions,
 * script writes to the DOM selection, script focus moves and editor DOM
 * mutations and script DOM writes. Every composition appends a one-line
 * summary to the native `logs/ime-selection.log`; a composition that loses
 * focus, loses WebKit's composition or keeps its marked text selected is also
 * written in full, as are the first compositions that start in ProseMirror's
 * cursor wrapper.
 * ⌃⌥⌘I writes the last compositions in full on demand. Records contain editor
 * positions, lengths, element shapes and call stacks, never prose.
 */
import type { Editor } from '@tiptap/core';
import { isChangeOrigin } from '@tiptap/extension-collaboration';
import type { Transaction } from '@tiptap/pm/state';
import { invoke } from '@tauri-apps/api/core';

/** Entries kept from before a composition starts. */
const PREROLL_ENTRIES = 30;
const MAX_ENTRIES = 1_500;
/** Full anomaly reports per page load; summaries are not limited. */
const MAX_REPORTS = 20;
/** Full records of ordinary cursor-wrapper compositions per page load. */
const MAX_CURSOR_WRAPPER_RECORDS = 10;
/** Compositions kept in memory for a manual dump. */
const HISTORY = 5;
const STACK_FRAMES = 24;
/** Commit-time transactions and selection changes still belong to the report. */
const TAIL_MS = 300;
/** ProseMirror's own reads of WebKit's insertion and caret are expected. */
const ENGINE_EVENTS = new Set(['input', 'selectionchange']);

export interface DomSelectionSnapshot {
  /** Editor positions of the DOM anchor and focus; null outside the document. */
  pm: [number | null, number | null];
  /** Anchor and focus as `node@offset`, without text. */
  nodes: [string, string];
  collapsed: boolean;
  /** Both ends in one text node, as WebKit requires to keep a composition. */
  sameText: boolean;
}

export interface TransactionSummary {
  docChanged: boolean;
  selectionSet: boolean;
  steps: number;
  metaKeys: string[];
  /** Applied by y-prosemirror from a Yjs update this editor did not make. */
  yjsRemote: boolean;
  composition: unknown;
}

export interface MutationSummary {
  text: number;
  childList: number;
  attributes: number;
  added: number;
  removed: number;
  targets: string[];
  addedNodes: string[];
  removedNodes: string[];
}

export type ImeAnomalyKind =
  /** The editor or the window lost focus while a composition was open. */
  | 'focus-lost'
  /** WebKit only dispatches `compositionstart` again after losing its composition. */
  | 'compositionstart-repeated'
  /** The DOM selection is still expanded after the `input` dispatch returned. */
  | 'after-input-expanded'
  /** A `selectionchange` during composition left the DOM selection expanded. */
  | 'selectionchange-expanded';

export interface CompositionStats {
  updates: number;
  /** `input` events whose DOM selection was WebKit's inserted range (normal). */
  inputExpanded: number;
  afterInputExpanded: number;
  selectionchanges: number;
  selectionchangeDomExpanded: number;
  repeatedStarts: number;
  /** Composition events dispatched to an element outside the editor. */
  outsideCompositionEvents: number;
  editorBlurs: number;
  windowBlurs: number;
  focusCalls: number;
  /** Transactions not caused by WebKit's `input` or `selectionchange`. */
  otherTransactions: number;
  otherTransactionMeta: string[];
  yjsRemoteTransactions: number;
  selectionWrites: number;
  /** ProseMirror placed the caret in its cursor wrapper at compositionstart. */
  cursorWrapper: boolean;
  /** Script writes to editor DOM nodes. */
  domWrites: number;
  childListMutations: number;
}

export interface ImeCompositionRecord {
  editor: string;
  /** Epoch milliseconds of compositionstart. */
  startedAt: number;
  durationMs: number | null;
  ended: boolean;
  anomaly: ImeAnomalyKind | null;
  /** Milliseconds after compositionstart. */
  detectedAtMs: number | null;
  stats: CompositionStats;
  droppedEntries: number;
  /** `t` is milliseconds relative to compositionstart. */
  entries: Array<{ t: number; kind: string } & Record<string, unknown>>;
}

interface RecordBase {
  event: 'ime-selection';
  utcOffsetMinutes: number;
}

export type ImeProbeRecord =
  | (RecordBase & {
      kind: ImeAnomalyKind | 'baseline' | 'cursor-wrapper';
      session: { compositions: number; anomalies: number; report: number };
      context: Record<string, unknown>;
      composition: ImeCompositionRecord;
    })
  | (RecordBase & { kind: 'composition'; composition: Omit<ImeCompositionRecord, 'entries'> })
  | (RecordBase & {
      kind: 'manual-dump';
      context: Record<string, unknown>;
      compositions: ImeCompositionRecord[];
    })
  | (RecordBase & {
      kind: 'probe-installed' | 'probe-attached' | 'probe-error';
      detail: Record<string, unknown>;
    });

/** The editor surface the probe observes. */
export interface ImeProbeTarget {
  /** Whether an event target is the editor or inside it. */
  owns(target: EventTarget | null): boolean;
  composing(): boolean;
  selection(): [number, number];
  domSelection(): DomSelectionSnapshot | null;
  onTransaction(listener: (summary: TransactionSummary) => void): () => void;
  observeMutations(listener: (summary: MutationSummary) => void): () => void;
  /** Shapes of the textblock around the caret: DOM children and model runs, no text. */
  blockShape(): { dom: string; model: string } | null;
}

export interface ImeProbeHost {
  /** Monotonic milliseconds. */
  now(): number;
  /** Epoch milliseconds. */
  wallNow(): number;
  /** Receives composition, input, focus and selection events (the document). */
  documentTarget: EventTarget;
  windowTarget: EventTarget;
  /** Element shape for logs: tag, id, classes, role and label, never content. */
  describe(target: EventTarget | null): string;
  /** `document.activeElement`, described. */
  activeElement(): string;
  hasFocus(): boolean;
  visibility(): string;
  /** Type of the event being dispatched, if any (`window.event`). */
  currentEventType(): string | null;
  stack(): string | undefined;
  setTimer(callback: () => void, ms: number): () => void;
  send(record: ImeProbeRecord): void;
  context(): Record<string, unknown>;
}

export interface ImeProbeSession {
  compositions: number;
  anomalies: number;
  reports: number;
  baselineSent: boolean;
  cursorWrapperRecords: number;
  history: ImeCompositionRecord[];
}

export interface AttachedImeProbe {
  /** A script call to a `Selection` mutator. */
  selectionWritten(method: string): void;
  /** A script call to `focus()` or `blur()` on an element. */
  focusCalled(method: string, element: string): void;
  /** Whether a composition (or its report tail) is being recorded. */
  observing(): boolean;
  /** A script write to a node inside the editor, recorded while observing. */
  domWritten(method: string, node: string): void;
  /** The `compositionstart` being dispatched when the probe was attached. */
  adopt(event: Event): void;
  /** History plus the open composition, if any. */
  dump(): ImeCompositionRecord[];
  detach(): void;
}

type Entry = { at: number; kind: string } & Record<string, unknown>;

export function createImeProbeSession(): ImeProbeSession {
  return { compositions: 0, anomalies: 0, reports: 0, baselineSent: false, cursorWrapperRecords: 0, history: [] };
}

const round = (ms: number) => Math.round(ms * 10) / 10;

export function utcOffsetMinutes(wallNow: number): number {
  return -new Date(wallNow).getTimezoneOffset();
}

/** Call-site frames without origins, cache-busting queries or probe frames. */
export function stackFrames(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split('\n')
    .map((line) => line.trim().replace(/^at\s+/, ''))
    .filter((line) => line && line !== 'Error' && !line.includes('dev-ime-probe'))
    .map((line) => line.replace(/[a-z]+:\/\/[^/\s)]+\//g, '/').replace(/\?[^:\s)]*(?=:\d)/g, ''))
    .slice(0, STACK_FRAMES);
}

const emptyStats = (): CompositionStats => ({
  updates: 0,
  inputExpanded: 0,
  afterInputExpanded: 0,
  selectionchanges: 0,
  selectionchangeDomExpanded: 0,
  repeatedStarts: 0,
  outsideCompositionEvents: 0,
  editorBlurs: 0,
  windowBlurs: 0,
  focusCalls: 0,
  otherTransactions: 0,
  otherTransactionMeta: [],
  yjsRemoteTransactions: 0,
  selectionWrites: 0,
  cursorWrapper: false,
  domWrites: 0,
  childListMutations: 0,
});

export function attachImeProbe(
  target: ImeProbeTarget,
  host: ImeProbeHost,
  session: ImeProbeSession,
  editorLabel = 'editor',
): AttachedImeProbe {
  let composing = false;
  /** Between compositionend and the end of an anomaly's report tail. */
  let ending = false;
  let startedAt = 0;
  let startedAtWall = 0;
  let endedAt = 0;
  let stats = emptyStats();
  let entries: Entry[] = [];
  let preroll: Entry[] = [];
  let dropped = 0;
  let anomaly: { kind: ImeAnomalyKind; at: number } | null = null;
  let cancelTail: (() => void) | null = null;
  let cancelAfterInput: (() => void) | null = null;

  const observing = () => composing || ending;

  const record = (kind: string, detail: Record<string, unknown> = {}) => {
    const entry: Entry = { at: host.now(), kind, ...detail };
    if (!observing()) {
      preroll.push(entry);
      if (preroll.length > PREROLL_ENTRIES) preroll.shift();
    } else if (entries.length < MAX_ENTRIES) {
      entries.push(entry);
    } else {
      dropped += 1;
    }
  };

  const clearTail = () => {
    cancelTail?.();
    cancelTail = null;
  };

  const cancelAfterInputCheck = () => {
    cancelAfterInput?.();
    cancelAfterInput = null;
  };

  const compositionRecord = (): ImeCompositionRecord => ({
    editor: editorLabel,
    startedAt: startedAtWall,
    durationMs: composing ? null : round(endedAt - startedAt),
    ended: !composing,
    anomaly: anomaly?.kind ?? null,
    detectedAtMs: anomaly ? round(anomaly.at - startedAt) : null,
    stats: { ...stats, otherTransactionMeta: [...stats.otherTransactionMeta] },
    droppedEntries: dropped,
    entries: entries.map(({ at, ...entry }) => ({ ...entry, t: round(at - startedAt) })),
  });

  /** Writes the summary and any full record, then keeps the tail as preroll. */
  const finish = () => {
    clearTail();
    const composition = compositionRecord();
    const base = { event: 'ime-selection' as const, utcOffsetMinutes: utcOffsetMinutes(host.wallNow()) };
    const summary: Omit<ImeCompositionRecord, 'entries'> & { entries?: unknown } = { ...composition };
    delete summary.entries;
    host.send({ ...base, kind: 'composition', composition: summary });
    const full = (kind: ImeAnomalyKind | 'baseline' | 'cursor-wrapper') => {
      host.send({
        ...base,
        kind,
        session: { compositions: session.compositions, anomalies: session.anomalies, report: session.reports },
        context: host.context(),
        composition,
      });
    };
    if (anomaly && session.reports < MAX_REPORTS) {
      session.reports += 1;
      full(anomaly.kind);
    } else if (!anomaly && stats.cursorWrapper && session.cursorWrapperRecords < MAX_CURSOR_WRAPPER_RECORDS) {
      // Successful cursor-wrapper compositions are the comparison set.
      session.cursorWrapperRecords += 1;
      full('cursor-wrapper');
    } else if (!anomaly && !session.baselineSent) {
      // One ordinary composition shows the engine's normal event order.
      session.baselineSent = true;
      full('baseline');
    }
    session.history.push(composition);
    if (session.history.length > HISTORY) session.history.shift();
    preroll = entries.slice(-PREROLL_ENTRIES);
    entries = [];
    dropped = 0;
    anomaly = null;
    ending = false;
  };

  const flag = (kind: ImeAnomalyKind) => {
    if (anomaly || !composing) return;
    anomaly = { kind, at: host.now() };
    session.anomalies += 1;
    record('anomaly', { anomaly: kind });
  };

  const selections = () => ({ pm: target.selection(), dom: target.domSelection() });
  const outside = (event: Event) =>
    target.owns(event.target) ? {} : { outside: host.describe(event.target) };

  const onCompositionStart = (event: Event) => {
    if (!target.owns(event.target)) {
      if (observing()) {
        stats.outsideCompositionEvents += 1;
        record('compositionstart', outside(event));
      }
      return;
    }
    if (composing) {
      stats.repeatedStarts += 1;
      record('compositionstart', { ...selections(), repeated: true });
      flag('compositionstart-repeated');
      return;
    }
    if (ending) finish();
    cancelAfterInputCheck();
    composing = true;
    startedAt = host.now();
    startedAtWall = host.wallNow();
    stats = emptyStats();
    entries = preroll;
    preroll = [];
    session.compositions += 1;
    record('compositionstart', {
      ...selections(),
      active: host.activeElement(),
      hasFocus: host.hasFocus(),
      block: target.blockShape(),
    });
  };

  const onCompositionUpdate = (event: Event) => {
    const owned = target.owns(event.target);
    if (!composing && !owned) return;
    if (!owned) stats.outsideCompositionEvents += 1;
    const data = (event as CompositionEvent).data ?? '';
    stats.updates += 1;
    record('compositionupdate', { length: data.length, latin: /^[\x20-\x7e]*$/.test(data), ...outside(event) });
  };

  const onCompositionEnd = (event: Event) => {
    if (!composing) return;
    if (!target.owns(event.target)) stats.outsideCompositionEvents += 1;
    record('compositionend', {
      length: ((event as CompositionEvent).data ?? '').length,
      ...outside(event),
      ...selections(),
    });
    composing = false;
    endedAt = host.now();
    if (!anomaly) {
      finish();
      return;
    }
    ending = true;
    clearTail();
    cancelTail = host.setTimer(finish, TAIL_MS);
  };

  const onInput = (event: Event) => {
    const input = event as InputEvent;
    const owned = target.owns(event.target);
    if (!observing() && !(owned && input.isComposing)) return;
    const current = selections();
    const firstInput = event.type === 'input' && composing && stats.updates === 1;
    record(event.type, {
      inputType: input.inputType,
      isComposing: input.isComposing,
      ...outside(event),
      ...current,
      ...(firstInput ? { block: target.blockShape() } : {}),
    });
    if (event.type !== 'input' || !composing || !owned) return;
    if (current.dom && !current.dom.collapsed) stats.inputExpanded += 1;
    // WebKit applies the input method's caret after this event returns.
    cancelAfterInputCheck();
    cancelAfterInput = host.setTimer(() => {
      cancelAfterInput = null;
      if (!composing) return;
      const dom = target.domSelection();
      record('after-input', { pm: target.selection(), dom });
      if (dom && !dom.collapsed) {
        stats.afterInputExpanded += 1;
        flag('after-input-expanded');
      }
    }, 0);
  };

  const onSelectionChange = () => {
    if (!observing()) return;
    const { pm, dom } = selections();
    record('selectionchange', { pm, dom });
    if (!composing) return;
    stats.selectionchanges += 1;
    if (dom && !dom.collapsed) {
      stats.selectionchangeDomExpanded += 1;
      flag('selectionchange-expanded');
    }
  };

  const onFocusMove = (event: Event) => {
    const owned = target.owns(event.target);
    const related = (event as FocusEvent).relatedTarget ?? null;
    record(event.type, {
      target: host.describe(event.target),
      related: related ? host.describe(related) : null,
      editor: owned,
      hasFocus: host.hasFocus(),
    });
    if (composing && event.type === 'focusout' && owned) {
      stats.editorBlurs += 1;
      flag('focus-lost');
    }
  };

  const onWindowFocus = (event: Event) => {
    if (event.target !== host.windowTarget) return;
    record(`window-${event.type}`, { active: host.activeElement(), hasFocus: host.hasFocus() });
    if (composing && event.type === 'blur') {
      stats.windowBlurs += 1;
      flag('focus-lost');
    }
  };

  const onVisibility = () => record('visibility', { state: host.visibility() });

  const offTransaction = target.onTransaction((summary) => {
    const inEvent = host.currentEventType();
    const engine = inEvent !== null && ENGINE_EVENTS.has(inEvent);
    if (composing && !engine) {
      stats.otherTransactions += 1;
      for (const key of summary.metaKeys) {
        if (!stats.otherTransactionMeta.includes(key)) stats.otherTransactionMeta.push(key);
      }
    }
    if (composing && summary.yjsRemote) stats.yjsRemoteTransactions += 1;
    record('transaction', {
      ...summary,
      inEvent,
      composingView: target.composing(),
      ...selections(),
      ...(observing() && !engine ? { stack: stackFrames(host.stack()) } : {}),
    });
  });

  const offMutations = target.observeMutations((summary) => {
    if (!observing()) return;
    if (composing) stats.childListMutations += summary.childList;
    record('mutation', { ...summary });
  });

  const documentTarget = host.documentTarget;
  const listeners: Array<[EventTarget, string, (event: Event) => void, boolean]> = [
    [documentTarget, 'compositionstart', onCompositionStart, true],
    [documentTarget, 'compositionupdate', onCompositionUpdate, true],
    [documentTarget, 'compositionend', onCompositionEnd, true],
    [documentTarget, 'beforeinput', onInput, true],
    [documentTarget, 'input', onInput, true],
    [documentTarget, 'focusin', onFocusMove, true],
    [documentTarget, 'focusout', onFocusMove, true],
    [documentTarget, 'visibilitychange', onVisibility, false],
    // Bubble phase: after ProseMirror's own listener has read the selection.
    [documentTarget, 'selectionchange', onSelectionChange, false],
    [host.windowTarget, 'focus', onWindowFocus, false],
    [host.windowTarget, 'blur', onWindowFocus, false],
  ];
  for (const [eventTarget, type, listener, capture] of listeners) {
    eventTarget.addEventListener(type, listener, { capture });
  }

  return {
    selectionWritten(method) {
      if (!observing()) return;
      if (composing) stats.selectionWrites += 1;
      record('selection-write', {
        method,
        inEvent: host.currentEventType(),
        dom: target.domSelection(),
        stack: stackFrames(host.stack()),
      });
    },
    observing,
    domWritten(method, node) {
      if (!observing()) return;
      if (composing) stats.domWrites += 1;
      // ProseMirror's cursor wrapper is an img.ProseMirror-separator widget.
      if (composing && node.startsWith('img.ProseMirror-separator')) stats.cursorWrapper = true;
      record('dom-write', { method, node, inEvent: host.currentEventType(), stack: stackFrames(host.stack()) });
    },
    focusCalled(method, element) {
      if (composing) stats.focusCalls += 1;
      record('focus-call', { method, element, inEvent: host.currentEventType(), stack: stackFrames(host.stack()) });
    },
    adopt: onCompositionStart,
    dump() {
      return observing() ? [...session.history, compositionRecord()] : [...session.history];
    },
    detach() {
      for (const [eventTarget, type, listener, capture] of listeners) {
        eventTarget.removeEventListener(type, listener, { capture });
      }
      offTransaction();
      offMutations();
      cancelAfterInputCheck();
      if (!observing()) return;
      if (composing) endedAt = host.now();
      composing = false;
      finish();
    },
  };
}

// ---------------------------------------------------------------------------
// Browser installation

function describeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return `#text[${node.nodeValue?.length ?? 0}]`;
  const element = node as Element;
  const name = element.tagName?.toLowerCase() ?? node.nodeName;
  const className = element.classList?.[0];
  return className ? `${name}.${className}` : name;
}

/** Tag, id, two classes, role and accessible label; no content. */
export function describeElement(target: EventTarget | null): string {
  if (!target) return 'null';
  if (typeof Window !== 'undefined' && target instanceof Window) return 'window';
  if (typeof Document !== 'undefined' && target instanceof Document) return 'document';
  if (!(target instanceof Element)) return String(target);
  let shape = target.tagName.toLowerCase();
  if (target.id) shape += `#${target.id}`;
  for (const name of [...target.classList].slice(0, 2)) shape += `.${name}`;
  const role = target.getAttribute('role');
  if (role) shape += `[role=${role}]`;
  const label = target.getAttribute('aria-label') ?? target.getAttribute('placeholder');
  if (label) shape += `[label=${label.slice(0, 40)}]`;
  if ((target as HTMLElement).isContentEditable) shape += '[editable]';
  return shape;
}

function summarizeTransaction(transaction: Transaction): TransactionSummary {
  const meta = (transaction as unknown as { meta?: Record<string, unknown> }).meta ?? {};
  return {
    docChanged: transaction.docChanged,
    selectionSet: transaction.selectionSet,
    steps: transaction.steps.length,
    metaKeys: Object.keys(meta),
    yjsRemote: isChangeOrigin(transaction),
    composition: transaction.getMeta('composition') ?? null,
  };
}

function summarizeMutations(records: MutationRecord[]): MutationSummary {
  const summary: MutationSummary = {
    text: 0,
    childList: 0,
    attributes: 0,
    added: 0,
    removed: 0,
    targets: [],
    addedNodes: [],
    removedNodes: [],
  };
  const targets = new Set<string>();
  for (const record of records) {
    if (record.type === 'characterData') {
      summary.text += 1;
      continue;
    }
    if (record.type === 'childList') {
      summary.childList += 1;
      summary.added += record.addedNodes.length;
      summary.removed += record.removedNodes.length;
      targets.add(describeNode(record.target));
      for (const node of record.addedNodes) if (summary.addedNodes.length < 6) summary.addedNodes.push(describeNode(node));
      for (const node of record.removedNodes) if (summary.removedNodes.length < 6) summary.removedNodes.push(describeNode(node));
    } else {
      summary.attributes += 1;
      targets.add(`${describeNode(record.target)}[${record.attributeName}]`);
    }
  }
  summary.targets = [...targets].slice(0, 6);
  return summary;
}

export function editorImeProbeTarget(editor: Editor): ImeProbeTarget {
  const view = editor.view;
  const position = (node: Node, offset: number): number | null => {
    if (!view.dom.contains(node)) return null;
    try {
      return view.posAtDOM(node, offset);
    } catch {
      return null;
    }
  };
  return {
    owns: (target) => target instanceof Node && view.dom.contains(target),
    composing: () => view.composing,
    selection: () => [editor.state.selection.anchor, editor.state.selection.head],
    domSelection() {
      const selection = view.dom.ownerDocument.getSelection();
      const { anchorNode, focusNode } = selection ?? {};
      if (!selection || !anchorNode || !focusNode) return null;
      return {
        pm: [position(anchorNode, selection.anchorOffset), position(focusNode, selection.focusOffset)],
        nodes: [
          `${describeNode(anchorNode)}@${selection.anchorOffset}`,
          `${describeNode(focusNode)}@${selection.focusOffset}`,
        ],
        collapsed: selection.isCollapsed,
        sameText: anchorNode === focusNode && anchorNode.nodeType === Node.TEXT_NODE,
      };
    },
    onTransaction(listener) {
      const handler = ({ transaction }: { transaction: Transaction }) => {
        listener(summarizeTransaction(transaction));
      };
      editor.on('transaction', handler);
      return () => {
        editor.off('transaction', handler);
      };
    },
    observeMutations(listener) {
      const observer = new MutationObserver((records) => listener(summarizeMutations(records)));
      observer.observe(view.dom, { childList: true, subtree: true, characterData: true, attributes: true });
      return () => observer.disconnect();
    },
    blockShape() {
      const $head = editor.state.selection.$head;
      if (!$head.parent.inlineContent) return null;
      const runs: string[] = [];
      $head.parent.forEach((child) => {
        const marks = child.marks.map((mark) =>
          mark.type.name === 'entityLink' ? `link#${shortHash(String(mark.attrs.targetId))}` : mark.type.name);
        runs.push(`${child.isText ? child.text!.length : child.type.name}${marks.length ? `:${marks.join('+')}` : ''}`);
      });
      let block: Node | null = null;
      try {
        block = view.domAtPos($head.start()).node;
      } catch {
        block = null;
      }
      const element = block?.nodeType === Node.TEXT_NODE ? block.parentElement : (block as Element | null);
      const dom = element
        ? [...element.childNodes].map((child) =>
            child.nodeType === Node.TEXT_NODE
              ? describeNode(child)
              : `${describeNode(child)}(${[...child.childNodes].map(describeNode).join(',')})`).join(' ')
        : '';
      return { dom, model: `@${$head.parentOffset} ${runs.join(' | ')}` };
    },
  };
}

/** Distinguishes link targets in logs without recording their ids. */
function shortHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index++) hash = (hash * 31 + value.charCodeAt(index)) | 0;
  return (hash >>> 0).toString(36).slice(0, 4);
}

/** Tiptap stores its editor on the view's root element. */
function editorFromTarget(target: EventTarget | null): Editor | null {
  for (let node = target as Node | null; node; node = node.parentNode) {
    const candidate = (node as { editor?: Partial<Editor> }).editor;
    if (candidate?.view && typeof candidate.on === 'function' && !candidate.isDestroyed) {
      return candidate as Editor;
    }
  }
  return null;
}

/**
 * Wraps prototype methods to report script calls; returns the restore. `before`
 * reports while the receiver is still in place (removals, focus moves).
 */
function wrapMethods(
  prototype: object,
  methods: readonly string[],
  onCall: (method: string, receiver: unknown, args: unknown[]) => void,
  before = false,
): () => void {
  const target = prototype as Record<string, (...args: unknown[]) => unknown>;
  const originals = methods.map((method) => [method, target[method]] as const);
  for (const [method, original] of originals) {
    if (typeof original !== 'function') continue;
    target[method] = function (this: unknown, ...args: unknown[]) {
      if (before) onCall(method, this, args);
      const result = original.apply(this, args);
      if (!before) onCall(method, this, args);
      return result;
    };
  }
  return () => {
    for (const [method, original] of originals) {
      if (typeof original === 'function') target[method] = original;
    }
  };
}

const SELECTION_WRITES = [
  'addRange',
  'collapse',
  'collapseToEnd',
  'collapseToStart',
  'empty',
  'extend',
  'removeAllRanges',
  'selectAllChildren',
  'setBaseAndExtent',
  'setPosition',
] as const;

/** Wraps a property setter to report writes; returns the restore. */
function wrapSetter(prototype: object, property: string, onSet: (receiver: unknown) => void): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
  const set = descriptor?.set;
  if (!descriptor || !set) return () => undefined;
  Object.defineProperty(prototype, property, {
    ...descriptor,
    set(this: unknown, value: unknown) {
      set.call(this, value);
      onSet(this);
    },
  });
  return () => Object.defineProperty(prototype, property, descriptor);
}

/** The node a DOM method changes: the inserted or removed child, else the receiver. */
function writtenNode(method: string, receiver: unknown, args: unknown[]): Node | null {
  const first = args[0];
  if ((method === 'insertBefore' || method === 'appendChild' || method === 'removeChild' || method === 'replaceChild') &&
      first instanceof Node) {
    return first;
  }
  return receiver instanceof Node ? receiver : null;
}

/** Reports script calls that change the DOM selection; returns the restore. */
export function wrapSelectionWrites(onWrite: (method: string) => void): () => void {
  return wrapMethods(Selection.prototype, SELECTION_WRITES, (method) => onWrite(method));
}

export function browserImeProbeHost(send: (record: ImeProbeRecord) => void): ImeProbeHost {
  return {
    now: () => performance.now(),
    wallNow: () => Date.now(),
    documentTarget: document,
    windowTarget: window,
    describe: describeElement,
    activeElement: () => describeElement(document.activeElement),
    hasFocus: () => document.hasFocus(),
    visibility: () => document.visibilityState,
    currentEventType: () => (globalThis as { event?: Event }).event?.type ?? null,
    stack: () => new Error().stack,
    setTimer(callback, ms) {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    },
    send,
    context: () => ({
      route: location.hash || location.pathname,
      focused: document.hasFocus(),
    }),
  };
}

const INSTALLED = '__DRIFTING_DEV_IME_PROBE__';

/** ⌃⌥⌘I */
const isDumpShortcut = (event: KeyboardEvent) =>
  event.code === 'KeyI' && event.ctrlKey && event.altKey && event.metaKey && !event.shiftKey;

export function installDevImeProbe(): () => void {
  const global = window as unknown as Record<string, unknown>;
  if (global[INSTALLED]) return () => undefined;
  global[INSTALLED] = true;

  let sendFailed = false;
  const send = (record: ImeProbeRecord) => {
    if (record.kind !== 'composition') console.warn(`[dev-ime-probe] ${record.kind}`);
    invoke('dev_ime_selection_report', { report: record }).catch((error: unknown) => {
      if (sendFailed) return;
      sendFailed = true;
      console.warn('[dev-ime-probe] could not write logs/ime-selection.log:', error);
    });
  };
  const status = (kind: 'probe-installed' | 'probe-attached' | 'probe-error', detail: Record<string, unknown>) =>
    send({ event: 'ime-selection', kind, utcOffsetMinutes: utcOffsetMinutes(Date.now()), detail });
  const session = createImeProbeSession();
  const host = browserImeProbeHost(send);

  let attachments = 0;
  let attached: { editor: Editor; probe: AttachedImeProbe; onDestroy: () => void } | null = null;
  const detach = () => {
    if (!attached) return;
    attached.editor.off('destroy', attached.onDestroy);
    attached.probe.detach();
    attached = null;
  };
  const attach = (editor: Editor) => {
    detach();
    attachments += 1;
    const label = `editor-${attachments}`;
    try {
      const probe = attachImeProbe(editorImeProbeTarget(editor), host, session, label);
      const onDestroy = () => {
        if (attached?.editor === editor) detach();
      };
      editor.on('destroy', onDestroy);
      attached = { editor, probe, onDestroy };
      status('probe-attached', {
        editor: label,
        docSize: editor.state.doc.content.size,
        element: describeElement(editor.view.dom),
        route: location.hash || location.pathname,
      });
    } catch (error) {
      status('probe-error', { stage: 'attach', editor: label, error: String(error) });
    }
  };

  // Listeners added to the document during this dispatch miss the current
  // event, so a newly attached probe adopts it.
  const onCompositionStart = (event: Event) => {
    const editor = editorFromTarget(event.target);
    if (!editor || editor === attached?.editor) return;
    attach(editor);
    attached?.probe.adopt(event);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!isDumpShortcut(event)) return;
    event.preventDefault();
    send({
      event: 'ime-selection',
      kind: 'manual-dump',
      utcOffsetMinutes: utcOffsetMinutes(Date.now()),
      context: host.context(),
      compositions: attached?.probe.dump() ?? [...session.history],
    });
  };

  const restores: Array<() => void> = [];
  try {
    restores.push(wrapSelectionWrites((method) => attached?.probe.selectionWritten(method)));
    restores.push(
      wrapMethods(
        HTMLElement.prototype,
        ['focus', 'blur'],
        (method, element) => attached?.probe.focusCalled(method, describeElement(element as Element)),
        true,
      ),
    );
    // ProseMirror writes the editor DOM only through these.
    const onDomWrite = (method: string, receiver: unknown, args: unknown[] = []) => {
      if (!attached?.probe.observing()) return;
      const root = attached.editor.view.dom;
      const node = writtenNode(method, receiver, args);
      const parent = receiver instanceof Node ? receiver : null;
      if (!(parent && root.contains(parent)) && !(node && root.contains(node))) return;
      attached.probe.domWritten(method, node ? describeNode(node) : 'unknown');
    };
    restores.push(wrapMethods(Node.prototype, ['insertBefore', 'appendChild', 'removeChild', 'replaceChild'], onDomWrite, true));
    restores.push(wrapMethods(Element.prototype, ['remove', 'replaceWith', 'before', 'after', 'append', 'prepend'], onDomWrite, true));
    restores.push(
      wrapMethods(
        CharacterData.prototype,
        ['remove', 'replaceWith', 'appendData', 'insertData', 'deleteData', 'replaceData'],
        onDomWrite,
        true,
      ),
    );
    restores.push(wrapSetter(Node.prototype, 'nodeValue', (receiver) => onDomWrite('nodeValue', receiver)));
    restores.push(wrapSetter(Node.prototype, 'textContent', (receiver) => onDomWrite('textContent', receiver)));
    restores.push(wrapSetter(CharacterData.prototype, 'data', (receiver) => onDomWrite('data', receiver)));
    document.addEventListener('compositionstart', onCompositionStart, { capture: true });
    window.addEventListener('keydown', onKeyDown, { capture: true });
    status('probe-installed', { route: location.hash || location.pathname });
  } catch (error) {
    status('probe-error', { stage: 'install', error: String(error) });
  }

  return () => {
    document.removeEventListener('compositionstart', onCompositionStart, { capture: true });
    window.removeEventListener('keydown', onKeyDown, { capture: true });
    detach();
    for (const restore of restores) restore();
    delete global[INSTALLED];
  };
}
