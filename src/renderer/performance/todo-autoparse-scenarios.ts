import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { BlockId } from '../lib/extensions/block-id';
import { useTodoAutoParse } from '../hooks/useTodoAutoParse';
import { useDataStore } from '../store/data-store';
import type { Comment } from '../domain/comment';
import { deferred, todoAutoParseCalls } from './todo-autoparse-services';

/** Real hook/editor with synthetic comment writes controlled across teardown. */
export async function runTodoAutoParseScenarios() {
  const host = document.createElement('div'); const prose = document.createElement('div'); document.body.append(host, prose);
  const root = createRoot(host);
  const editor = new Editor({ element: prose, extensions: [StarterKit, BlockId], content: '<p>Author prose.</p><p>TODO: First synthetic task</p><p>待办：第二个任务</p>' });
  const originalComments = useDataStore.getState().comments;
  const checks: string[] = [];
  const check = (name: string, valid: unknown) => { if (!valid) throw new Error(`TODO parser: ${name}`); checks.push(name); };
  const pause = (ms = 0) => new Promise<void>(resolve => setTimeout(resolve, ms));
  function Mount() { useTodoAutoParse({ editor, projectId: 'synthetic-todo-project', nodeId: 'synthetic-todo-node', userId: 'synthetic-user' }); return null; }
  const render = (visible = true) => flushSync(() => root.render(visible ? createElement(Mount) : null));
  try {
    useDataStore.setState({ comments: [] });
    editor.view.focus(); editor.commands.setTextSelection(2);
    await pause(); // Let BlockId's mount microtask finish before counting scans.
    // Trap the expensive scan itself, not just the eventual service writes.
    const doc = editor.state.doc; const descendants = doc.descendants.bind(doc); let scans = 0;
    doc.descendants = (...args) => { scans++; return descendants(...args); };
    render();
    editor.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    await pause(1350);
    check('TODO initial scan yields to an open candidate window', scans === 0 && todoAutoParseCalls.todos.length === 0 && editor.view.composing);
    const blockedCreate = deferred<void>(); todoAutoParseCalls.blockedTodoWrite = blockedCreate;
    editor.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    await pause(1350);
    check('TODO scan resumes once composition ends', todoAutoParseCalls.todos.length === 1);
    render(false); blockedCreate.resolve(); await pause();
    check('unmount during a write stops remaining TODO creates', todoAutoParseCalls.todos.length === 1);
    todoAutoParseCalls.blockedTodoWrite = null;
    doc.descendants = descendants;

    // With no marker left, a sweep would delete both open projections. Closing
    // its owner after the first await must preserve the second projection.
    editor.commands.setContent('<p>Author prose without markers.</p>');
    const comments: Comment[] = ['first', 'second'].map(id => ({ id, projectId: 'synthetic-todo-project', targetId: 'synthetic-todo-node', kind: 'todo', targetKind: 'node', targetBlockId: id,
      anchorJson: '{}', authorKind: 'user', authorId: null, authorName: null, bodyJson: '{}', status: 'open', priority: null, source: 'manual',
      metadataJson: JSON.stringify({ kind: 'todo-autoparse', blockId: id }), targetBlockIdsJson: '[]', resolvedAt: null, createdAt: '2026-01-01', updatedAt: '2026-01-01' }));
    useDataStore.setState({ comments });
    const blockedDelete = deferred<void>(); todoAutoParseCalls.blockedTodoWrite = blockedDelete;
    render(); await pause(1350);
    check('controlled stale TODO cleanup starts one delete', todoAutoParseCalls.deletedTodos.length === 1);
    render(false); blockedDelete.resolve(); await pause();
    check('unmount during cleanup stops remaining TODO deletes', todoAutoParseCalls.deletedTodos.length === 1);
    todoAutoParseCalls.blockedTodoWrite = null;
    editor.view.focus(); editor.commands.insertContent('继续写作'); await pause(1350);
    check('closed TODO work leaves editor focus and content intact', document.activeElement === editor.view.dom && editor.getText().includes('继续写作') && todoAutoParseCalls.todos.length === 1 && todoAutoParseCalls.deletedTodos.length === 1);
    return { checks, creates: todoAutoParseCalls.todos.length, deletes: todoAutoParseCalls.deletedTodos.length,
      scope: 'Actual React hook and Tiptap, synthetic composition events, controlled comment services; no native input or database writes.' };
  } finally {
    render(false); root.unmount(); todoAutoParseCalls.blockedTodoWrite?.resolve(); todoAutoParseCalls.blockedTodoWrite = null;
    editor.destroy(); host.remove(); prose.remove(); useDataStore.setState({ comments: originalComments });
  }
}
