import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import {
  attachImeProbe,
  createImeProbeSession,
  stackFrames,
  type DomSelectionSnapshot,
  type ImeProbeHost,
  type ImeProbeRecord,
  type MutationSummary,
  type TransactionSummary,
} from './dev-ime-probe';

const caret = (pos: number): DomSelectionSnapshot => ({
  pm: [pos, pos],
  nodes: [`#text[13]@${pos}`, `#text[13]@${pos}`],
  collapsed: true,
  sameText: true,
});
const range = (from: number, to: number): DomSelectionSnapshot => ({
  pm: [from, to],
  nodes: [`#text[13]@${from}`, `#text[13]@${to}`],
  collapsed: false,
  sameText: true,
});

const TRANSACTION: TransactionSummary = {
  docChanged: false,
  selectionSet: true,
  steps: 0,
  metaKeys: ['y-sync$'],
  yjsRemote: true,
  composition: null,
};

function setup({ attach = true } = {}) {
  /** Identity of the editor root; events are dispatched on the document. */
  const editorDom = new EventTarget();
  const panel = new EventTarget();
  const document = new EventTarget();
  const window = new EventTarget();
  const records: ImeProbeRecord[] = [];
  let domSelection: DomSelectionSnapshot | null = caret(9);
  let pmSelection: [number, number] = [9, 9];
  let currentEvent: string | null = null;
  let transactionListener: ((summary: TransactionSummary) => void) | null = null;
  let mutationListener: ((summary: MutationSummary) => void) | null = null;

  const describe = (target: EventTarget | null) =>
    target === editorDom ? 'div.tiptap.ProseMirror[editable]' : target === panel ? 'textarea.agent-input' : 'document';
  const host: ImeProbeHost = {
    now: () => Date.now(),
    wallNow: () => Date.now(),
    documentTarget: document,
    windowTarget: window,
    describe,
    activeElement: () => 'div.tiptap.ProseMirror[editable]',
    hasFocus: () => true,
    visibility: () => 'visible',
    currentEventType: () => currentEvent,
    stack: () => 'Error\n    at _typeChanged (http://localhost:1420/node_modules/.vite/deps/y-prosemirror.js?v=1:10:2)',
    setTimer(callback, ms) {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    },
    send: (record) => records.push(record),
    context: () => ({ route: '#/project/p1' }),
  };
  const session = createImeProbeSession();
  // Tests that are not about the baseline start after it.
  session.baselineSent = true;
  const create = () =>
    attachImeProbe(
      {
        owns: (target) => target === editorDom,
        composing: () => false,
        selection: () => pmSelection,
        domSelection: () => domSelection,
        onTransaction(listener) {
          transactionListener = listener;
          return () => {
            transactionListener = null;
          };
        },
        observeMutations(listener) {
          mutationListener = listener;
          return () => {
            mutationListener = null;
          };
        },
        blockShape: () => ({ dom: '#text[5] span.entity-link(#text[2])', model: '@7 5 | 2:link#abcd' }),
      },
      host,
      session,
      'editor-1',
    );
  const probe = attach ? create() : null;

  const event = (type: string, detail: Record<string, unknown>, target: EventTarget) => {
    const created = Object.assign(new Event(type), detail);
    Object.defineProperty(created, 'target', { value: target });
    return created;
  };
  /** Dispatches through the document as if the event targeted `target`. */
  const fire = (type: string, detail: Record<string, unknown> = {}, target: EventTarget = editorDom) => {
    currentEvent = type;
    document.dispatchEvent(event(type, detail, target));
    currentEvent = null;
  };
  /** One WebKit marked-text update: insert selected, `input`, then the IME caret. */
  const keystroke = (text: string, from = 9) => {
    fire('compositionupdate', { data: text });
    domSelection = range(from, from + text.length);
    pmSelection = [from, from + text.length];
    fire('input', { inputType: 'insertCompositionText', isComposing: true });
    domSelection = caret(from + text.length);
  };
  /** The probe reads first; ProseMirror then follows the DOM caret. */
  const selectionChange = () => {
    fire('selectionchange', {}, document);
    if (domSelection) pmSelection = [domSelection.pm[0] ?? 0, domSelection.pm[1] ?? 0];
  };
  const full = () => records.filter((record) => 'composition' in record && record.kind !== 'composition');
  const summaries = () => records.filter((record) => record.kind === 'composition');

  return {
    editorDom,
    panel,
    window,
    probe: probe!,
    create,
    event,
    session,
    records,
    full,
    summaries,
    fire,
    keystroke,
    selectionChange,
    setDomSelection: (next: DomSelectionSnapshot) => {
      domSelection = next;
    },
    withEvent: (type: string, callback: () => void) => {
      currentEvent = type;
      callback();
      currentEvent = null;
    },
    transaction: (summary = TRANSACTION, inEvent: string | null = null) => {
      currentEvent = inEvent;
      transactionListener?.(summary);
      currentEvent = null;
    },
    mutation: (summary: MutationSummary) => mutationListener?.(summary),
    hasListeners: () => transactionListener !== null || mutationListener !== null,
  };
}

function entriesOf(record: ImeProbeRecord | undefined) {
  if (!record || !('composition' in record) || !('entries' in record.composition)) throw new Error('no full record');
  return record.composition.entries;
}

describe('dev IME selection probe', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-05T06:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('summarizes ordinary compositions and writes one full baseline per session', () => {
    const probe = setup();
    probe.session.baselineSent = false;
    for (let round = 0; round < 2; round++) {
      probe.fire('compositionstart');
      for (const text of ['x', 'xi', 'xia', 'xian', 'xiang']) {
        probe.keystroke(text);
        vi.advanceTimersByTime(0);
        probe.selectionChange();
        // ProseMirror's own caret read is not an out-of-band transaction.
        probe.transaction({ ...TRANSACTION, metaKeys: ['composition'], yjsRemote: false }, 'selectionchange');
      }
      probe.fire('compositionend', { data: '想' });
      vi.advanceTimersByTime(10_000);
    }

    expect(probe.full().map((record) => record.kind)).toEqual(['baseline']);
    expect(probe.summaries()).toHaveLength(2);
    expect(probe.summaries()[0]).toMatchObject({
      composition: {
        editor: 'editor-1',
        ended: true,
        anomaly: null,
        stats: { updates: 5, inputExpanded: 5, afterInputExpanded: 0, selectionchangeDomExpanded: 0, otherTransactions: 0 },
      },
    });
    expect(probe.session).toMatchObject({ compositions: 2, anomalies: 0 });
  });

  it('reports a selection expanded after the caret, with the transaction that wrote it', () => {
    const probe = setup();
    probe.fire('compositionstart');
    probe.keystroke('xiang');
    vi.advanceTimersByTime(0);
    probe.selectionChange();
    // A later transaction writes ProseMirror's stale expanded selection back.
    probe.setDomSelection(range(9, 14));
    probe.transaction();
    probe.selectionChange();
    vi.advanceTimersByTime(100);
    probe.fire('compositionend', { data: '想' });
    probe.selectionChange();
    expect(probe.records).toEqual([]);
    vi.advanceTimersByTime(300);

    const [report] = probe.full();
    expect(report).toMatchObject({
      event: 'ime-selection',
      kind: 'selectionchange-expanded',
      session: { compositions: 1, anomalies: 1, report: 1 },
      context: { route: '#/project/p1' },
      composition: {
        ended: true,
        anomaly: 'selectionchange-expanded',
        stats: { otherTransactions: 1, otherTransactionMeta: ['y-sync$'], yjsRemoteTransactions: 1 },
      },
    });
    const entries = entriesOf(report);
    expect(entries.map((entry) => entry.kind)).toEqual([
      'compositionstart',
      'compositionupdate',
      'input',
      'after-input',
      'selectionchange',
      'transaction',
      'selectionchange',
      'anomaly',
      'compositionend',
      'selectionchange',
    ]);
    const transaction = entries.find((entry) => entry.kind === 'transaction');
    expect(transaction).toMatchObject({ yjsRemote: true, inEvent: null, dom: { collapsed: false } });
    expect(transaction?.stack).toEqual(['_typeChanged (/node_modules/.vite/deps/y-prosemirror.js:10:2)']);
    expect(probe.summaries()).toHaveLength(1);
    expect(JSON.stringify(probe.records)).not.toContain('想');
  });

  it('reports marked text that WebKit left selected after the input event', () => {
    const probe = setup();
    probe.fire('compositionstart');
    probe.fire('compositionupdate', { data: 'xiang' });
    probe.setDomSelection(range(9, 14));
    probe.fire('input', { inputType: 'insertCompositionText', isComposing: true });
    probe.mutation({
      text: 1,
      childList: 1,
      attributes: 0,
      added: 1,
      removed: 1,
      targets: ['p'],
      addedNodes: ['#text[5]'],
      removedNodes: ['#text[5]'],
    });
    vi.advanceTimersByTime(0);
    probe.fire('compositionend', { data: '想' });
    vi.advanceTimersByTime(300);

    expect(probe.full().map((record) => record.kind)).toEqual(['after-input-expanded']);
    const entries = entriesOf(probe.full()[0]);
    expect(entries.find((entry) => entry.kind === 'compositionupdate')).toMatchObject({ length: 5, latin: true });
    expect(entries.some((entry) => entry.kind === 'mutation')).toBe(true);
    expect(probe.summaries()[0]).toMatchObject({ composition: { stats: { childListMutations: 1, afterInputExpanded: 1 } } });
  });

  it('reports focus taken from the editor, who took it and where the composition ended', () => {
    const probe = setup();
    probe.fire('compositionstart');
    probe.keystroke('xi');
    probe.probe.focusCalled('focus', 'textarea.agent-input');
    probe.fire('focusout', { relatedTarget: probe.panel });
    probe.fire('focusin', { relatedTarget: probe.editorDom }, probe.panel);
    probe.fire('compositionend', { data: 'xi' }, probe.panel);
    vi.advanceTimersByTime(300);

    const [report] = probe.full();
    expect(report).toMatchObject({
      kind: 'focus-lost',
      composition: { stats: { editorBlurs: 1, focusCalls: 1, outsideCompositionEvents: 1 } },
    });
    const entries = entriesOf(report);
    expect(entries.find((entry) => entry.kind === 'focus-call')).toMatchObject({
      method: 'focus',
      element: 'textarea.agent-input',
      stack: ['_typeChanged (/node_modules/.vite/deps/y-prosemirror.js:10:2)'],
    });
    expect(entries.find((entry) => entry.kind === 'focusout')).toMatchObject({
      editor: true,
      related: 'textarea.agent-input',
    });
    expect(entries.find((entry) => entry.kind === 'compositionend')).toMatchObject({ outside: 'textarea.agent-input' });
  });

  it('reports the window losing focus during a composition', () => {
    const probe = setup();
    probe.fire('compositionstart');
    probe.keystroke('x');
    probe.window.dispatchEvent(new Event('blur'));
    probe.window.dispatchEvent(new Event('focus'));
    probe.fire('compositionend', { data: 'x' });
    vi.advanceTimersByTime(300);

    expect(probe.full()[0]).toMatchObject({ kind: 'focus-lost', composition: { stats: { windowBlurs: 1 } } });
    expect(entriesOf(probe.full()[0]).map((entry) => entry.kind)).toContain('window-focus');
  });

  it('reports WebKit restarting a composition it lost', () => {
    const probe = setup();
    probe.fire('compositionstart');
    probe.keystroke('x');
    probe.fire('compositionstart');
    probe.keystroke('xi');
    probe.fire('compositionend', { data: '洗' });
    vi.advanceTimersByTime(300);

    expect(probe.full().map((record) => record.kind)).toEqual(['compositionstart-repeated']);
    expect(probe.session.compositions).toBe(1);
    expect(probe.summaries()[0]).toMatchObject({ composition: { stats: { repeatedStarts: 1, updates: 2 } } });
  });

  it('adopts the compositionstart that caused the attachment and keeps earlier context', () => {
    const probe = setup({ attach: false });
    const attached = probe.create();
    attached.focusCalled('focus', 'div.tiptap.ProseMirror[editable]');
    attached.adopt(probe.event('compositionstart', {}, probe.editorDom));
    probe.keystroke('x');
    probe.setDomSelection(range(9, 10));
    probe.selectionChange();
    probe.fire('compositionend', { data: '洗' });
    vi.advanceTimersByTime(300);

    const entries = entriesOf(probe.full()[0]);
    expect(entries[0]).toMatchObject({ kind: 'focus-call' });
    expect(entries[0].t).toBeLessThanOrEqual(0);
    expect(entries[1]).toMatchObject({ kind: 'compositionstart', active: 'div.tiptap.ProseMirror[editable]' });
    expect(probe.session.compositions).toBe(1);
  });

  it('writes ordinary cursor-wrapper compositions in full with the DOM writes inside them', () => {
    const probe = setup();
    probe.fire('compositionstart');
    // ProseMirror's compositionstart handler selects its cursor wrapper.
    probe.transaction({ ...TRANSACTION, yjsRemote: false, metaKeys: [] }, 'compositionstart');
    probe.withEvent('compositionstart', () => probe.probe.domWritten('insertBefore', 'img.ProseMirror-separator'));
    probe.keystroke('x');
    probe.withEvent('input', () => probe.probe.domWritten('insertBefore', '#text[1]'));
    probe.mutation({
      text: 1,
      childList: 2,
      attributes: 0,
      added: 1,
      removed: 1,
      targets: ['p'],
      addedNodes: ['#text[1]'],
      removedNodes: ['img.ProseMirror-separator'],
    });
    vi.advanceTimersByTime(0);
    probe.selectionChange();
    probe.fire('compositionend', { data: '洗' });
    probe.probe.domWritten('nodeValue', '#text[2]');

    const [record] = probe.full();
    expect(record).toMatchObject({ kind: 'cursor-wrapper', composition: { stats: { cursorWrapper: true, domWrites: 2 } } });
    expect(entriesOf(record).find((entry) => entry.kind === 'compositionstart')).toMatchObject({
      block: { model: '@7 5 | 2:link#abcd' },
    });
    expect(entriesOf(record).find((entry) => entry.kind === 'dom-write' && entry.node === '#text[1]')).toMatchObject({
      method: 'insertBefore',
      node: '#text[1]',
      inEvent: 'input',
    });
    expect(probe.probe.observing()).toBe(false);
  });

  it('dumps recent compositions, records selection writes only while composing and detaches cleanly', () => {
    const probe = setup();
    probe.probe.selectionWritten('collapse');
    probe.fire('compositionstart');
    probe.fire('compositionend', { data: '' });
    probe.fire('compositionstart');
    probe.probe.selectionWritten('setBaseAndExtent');
    expect(probe.probe.dump().map((composition) => composition.ended)).toEqual([true, false]);

    probe.setDomSelection(range(9, 10));
    probe.selectionChange();
    probe.probe.detach();

    const writes = entriesOf(probe.full()[0]).filter((entry) => entry.kind === 'selection-write');
    expect(writes.map((entry) => entry.method)).toEqual(['setBaseAndExtent']);
    expect(probe.hasListeners()).toBe(false);
    probe.fire('compositionstart');
    expect(probe.session.compositions).toBe(2);
    expect(probe.session.history).toHaveLength(2);
  });

  it('keeps stack frames short and free of origins', () => {
    expect(
      stackFrames(
        [
          'Error',
          'selectionWritten@http://localhost:1420/src/renderer/lib/dev-ime-probe.ts?t=1:1:1',
          'selectionToDOM@http://localhost:1420/node_modules/.vite/deps/chunk-A.js?v=9:120:7',
          '    at dispatch (tauri://localhost/assets/index.js:3:4)',
        ].join('\n'),
      ),
    ).toEqual(['selectionToDOM@/node_modules/.vite/deps/chunk-A.js:120:7', 'dispatch (/assets/index.js:3:4)']);
  });
});
