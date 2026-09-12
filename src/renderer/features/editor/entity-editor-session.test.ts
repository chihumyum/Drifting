import type { Editor } from '@tiptap/core';
import { Schema, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EntityEditorSession, type EditorPersistDerived } from './entity-editor-session';

const schema = new Schema({ nodes: {
  doc: { content: 'block+' }, text: { group: 'inline' },
  paragraph: { group: 'block', content: 'text*', attrs: { id: { default: 'paragraph' } } },
  heading: { group: 'block', content: 'text*', attrs: { id: { default: 'heading' }, level: { default: 1 } } },
} });
function document(heading = 'Synthetic heading', prose = 'Synthetic prose') {
  return schema.node('doc', null, [schema.node('heading', null, [schema.text(heading)]), schema.node('paragraph', null, [schema.text(prose)])]);
}

// Real immutable ProseMirror documents, with an explicit event/clock double.
// Full Tiptap/Yjs and React lifecycle wiring is checked by the native harness.
function fixture(id = 'chapter') {
  const callbacks = new Map<string, Set<() => void>>();
  const emitter = {
    isDestroyed: false, isFocused: false, state: EditorState.create({ doc: document() }),
    getJSON() { return this.state.doc.toJSON(); },
    on(name: string, fn: () => void) { const listeners = callbacks.get(name) ?? new Set(); listeners.add(fn); callbacks.set(name, listeners); },
    off(name: string, fn: () => void) { callbacks.get(name)?.delete(fn); },
  };
  const editor = emitter as unknown as Editor;
  const persist = vi.fn<(editor: Editor, derived: EditorPersistDerived) => void>();
  const session = new EntityEditorSession(editor, { projectId: 'synthetic-project', sourceKind: 'node', sourceId: id });
  session.updateOptions({ onPersist: persist, selectionKey: null, autoFocus: true });
  const emit = (event: string) => { for (const callback of [...callbacks.get(event) ?? []]) callback(); };
  return { session, editor, emitter, persist, emit,
    listenerCount: () => [...callbacks.values()].reduce((sum, listeners) => sum + listeners.size, 0),
    update(doc: ProseMirrorNode) { emitter.state = EditorState.create({ doc }); emit('update'); },
  };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('canonical editor session ownership', () => {
  it('keeps a 400 ms trailing save, flushes blur/close, and cancels retired timers', () => {
    vi.useFakeTimers();
    const f = fixture(); const dispose = f.session.attach();
    f.update(document('One')); vi.advanceTimersByTime(300);
    f.update(document('Two')); vi.advanceTimersByTime(399);
    expect(f.persist).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(f.persist).toHaveBeenCalledTimes(1);
    expect(f.persist.mock.calls[0][1].outline[0].text).toBe('Two');
    f.update(document('Blur')); f.emit('blur');
    expect(f.persist).toHaveBeenCalledTimes(2);
    f.update(document('Close')); dispose();
    expect(f.persist).toHaveBeenCalledTimes(3);
    expect(f.persist.mock.calls[2][1].outline[0].text).toBe('Close');
    expect(f.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(f.persist).toHaveBeenCalledTimes(3);
  });

  it('never sends a retiring editor draft to the incoming source callback', () => {
    vi.useFakeTimers();
    const old = fixture('old'); const incoming = fixture('incoming');
    old.session.attach(); old.update(document('Old draft'));
    incoming.session.attach(); incoming.update(document('Incoming draft'));
    old.session.detach();
    expect(old.persist.mock.calls[0][1].outline[0].text).toBe('Old draft');
    expect(incoming.persist).not.toHaveBeenCalled();
    incoming.session.saveNow();
    expect(incoming.persist.mock.calls[0][1].outline[0].text).toBe('Incoming draft');
    incoming.session.detach();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refreshes a callback without restarting or dropping its pending task', () => {
    vi.useFakeTimers();
    const f = fixture(); f.session.attach(); f.update(document('Pending'));
    const refreshed = vi.fn();
    f.session.updateOptions({ onPersist: refreshed, selectionKey: null, autoFocus: true });
    vi.advanceTimersByTime(400);
    expect(f.persist).not.toHaveBeenCalled(); expect(refreshed).toHaveBeenCalledOnce();
    expect(f.listenerCount()).toBe(4); f.session.detach();
  });

  it('supports effect replay and cleans up on editor destruction', () => {
    vi.useFakeTimers();
    const f = fixture();
    const first = f.session.attach(); first(); f.session.attach();
    expect(f.listenerCount()).toBe(4);
    f.update(document('Before destroy')); f.emit('destroy'); f.emitter.isDestroyed = true;
    expect(f.persist).toHaveBeenCalledOnce(); expect(f.listenerCount()).toBe(0);
    f.session.detach(); expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels its initialization frame when an unfocused session is retired', () => {
    const requestFrame = vi.fn(() => 17); const cancelFrame = vi.fn();
    vi.stubGlobal('requestAnimationFrame', requestFrame);
    vi.stubGlobal('cancelAnimationFrame', cancelFrame);
    const f = fixture();
    Object.assign(f.emitter, { commands: { blur: vi.fn() }, view: { dispatch: vi.fn() } });
    f.session.updateOptions({ onPersist: f.persist, selectionKey: null, autoFocus: false });
    f.session.attach(); f.session.detach();
    expect(requestFrame).toHaveBeenCalledOnce();
    expect(cancelFrame).toHaveBeenCalledWith(17);
    expect(f.listenerCount()).toBe(0);
  });

  it('does not notify an outline consumer when only paragraph text changed', async () => {
    vi.useFakeTimers();
    const f = fixture(); f.session.setPresentationNeeded(true); f.session.attach();
    await Promise.resolve();
    const before = f.session.getSnapshot(); const notify = vi.fn(); const unsubscribe = f.session.subscribe(notify);
    f.update(document('Synthetic heading', 'A different paragraph')); vi.advanceTimersByTime(400);
    expect(f.persist).toHaveBeenCalledOnce(); expect(notify).not.toHaveBeenCalled();
    expect(f.session.getSnapshot()).toBe(before);
    expect(f.persist.mock.calls[0][1].pmJson).toContain('A different paragraph');
    unsubscribe(); f.session.detach();
  });

  it.each([1, 5, 20])('persists all %i sessions while publishing only visible outlines and preparing a hidden target', async count => {
    vi.useFakeTimers();
    const sessions = Array.from({ length: count }, (_, index) => fixture(String(index)));
    const notifications = sessions.map(() => vi.fn());
    const unsubscribers = sessions.map((f, index) => {
      f.session.setPresentationNeeded(index === 0); f.session.attach();
      return f.session.subscribe(notifications[index]);
    });
    await Promise.resolve();
    notifications.forEach(fn => fn.mockClear());
    for (const f of sessions) f.update(document('Updated while retained'));
    vi.advanceTimersByTime(400);
    for (const f of sessions) expect(f.persist).toHaveBeenCalledOnce();
    expect(notifications.reduce((sum, fn) => sum + fn.mock.calls.length, 0)).toBe(1);
    if (count > 1) {
      const hidden = sessions[1];
      expect(hidden.session.getSnapshot().ready).toBe(false);
      hidden.update(document('Latest, still pending save'));
      hidden.session.setPresentationNeeded(true);
      expect(hidden.session.getSnapshot()).toMatchObject({ ready: true, outline: [{ text: 'Latest, still pending save' }] });
      expect(notifications[1]).toHaveBeenCalledOnce();
      expect(hidden.persist).toHaveBeenCalledOnce(); // Preparation never forces a save.
    }
    unsubscribers.forEach(fn => fn()); sessions.forEach(f => f.session.detach());
    expect(sessions.reduce((sum, f) => sum + f.listenerCount(), 0)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for initial block IDs before publishing navigable JSON heading anchors', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.emitter.state = EditorState.create({ doc: schema.node('doc', null, [schema.node('heading', { id: null, level: 1 }, [schema.text('Initial heading')])]) });
    const publishedIds: string[] = [];
    f.session.subscribe(() => publishedIds.push(f.session.getSnapshot().outline[0].id));
    // This is the BlockId plugin's construction-time normalization ordering.
    queueMicrotask(() => f.update(schema.node('doc', null, [schema.node('heading', { id: 'canonical-block', level: 1 }, [schema.text('Initial heading')])])));
    f.session.setPresentationNeeded(true); f.session.attach();
    expect(f.session.getSnapshot().ready).toBe(false);
    await Promise.resolve();
    expect(publishedIds).toEqual(['canonical-block']);
    f.session.detach();
    expect(vi.getTimerCount()).toBe(0);
  });
});
