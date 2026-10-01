/** Synthetic DOM interactions; persistence callbacks do not access a database. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TodoCard } from '../src/renderer/features/library/TodoCard';
import { ReviewItemCard } from '../src/renderer/features/comments/ReviewItemCard';
import { ReviewPanel } from '../src/renderer/components/rightBars/ReviewPanel';
import { useDataStore } from '../src/renderer/store/data-store';
import { useUiStore } from '../src/renderer/store/ui-store';
import { WorkspaceNavigationProvider } from '../src/renderer/features/workspace/navigation/WorkspaceNavigationContext';
import { createPlainCommentDoc, type Comment } from '../src/renderer/domain/comment';
import { setI18nLocale } from '../src/renderer/lib/i18n';
import type { BookNode } from '../src/renderer/domain/book-node';
import type { BookElementCategory } from '../src/renderer/domain/book-element';
import '../src/styles/index.css';
import '../src/styles/ui-controls.css';
import '../src/styles/comments-review.css';
import '../src/styles/desktop-typography.css';

setI18nLocale('en');
document.documentElement.dataset.shellMode = 'desktop';
const initial = {
  id: 'synthetic-todo', projectId: 'synthetic-project', kind: 'todo', status: 'open',
  source: 'manual', bodyJson: createPlainCommentDoc('Check the synthetic timeline'),
  targetKind: 'node', targetId: 'synthetic-node', targetBlockId: 'synthetic-block',
  anchorJson: JSON.stringify({ selectedText: 'At dawn, the visitor returned.', blockSnapshots: [{ blockId: 'synthetic-block', blockText: 'Full synthetic paragraph, beyond the selection.' }] }), metadataJson: null,
} as Comment;
const observations = { saves: [] as string[], fail: false, jumps: 0, escaped: 0 };
window.addEventListener('keydown', (event) => { if (event.key === 'Escape') observations.escaped++; });
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const reviewComments = [
  { id: 'open-a', kind: 'todo', status: 'open', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-04T00:00:00.000Z', targetBlockId: 'synthetic-block' },
  { id: 'open-b', kind: 'note', status: 'open', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-03T00:00:00.000Z', targetBlockId: null },
  { id: 'resolved-c', kind: 'todo', status: 'resolved', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-03T00:00:00.000Z', targetBlockId: null },
  { id: 'resolved-d', kind: 'note', status: 'resolved', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-04T00:00:00.000Z', targetBlockId: 'synthetic-block' },
].map((comment) => ({ ...initial, ...comment, bodyJson: createPlainCommentDoc(`Synthetic ${comment.id}`) })) as Comment[];
useDataStore.getState().setComments(reviewComments);
useDataStore.setState({
  bookNodes: [{ id: 'synthetic-node', projectId: initial.projectId, kind: 'chapter', title: 'The synthetic arrival' } as BookNode],
  bookElementCategories: ['A', 'B'].map((suffix) => ({ id: `Synthetic relation ${suffix}`, projectId: initial.projectId, name: `Synthetic relation ${suffix}` }) as BookElementCategory),
});

export function Fixture() {
  const [todo, setTodo] = useState(initial);
  const [reviewKey, setReviewKey] = useState(0);
  const [hasFocusedEntity, setHasFocusedEntity] = useState(true);
  return <WorkspaceNavigationProvider navigator={{ projectId: initial.projectId,
    open() { observations.jumps++; }, activate() {}, showProjectHome() {}, leaveDeletedTarget() {} }}>
    <main style={{ display: 'flex', flexWrap: 'wrap', gap: 24, padding: 24 }}>
      <button hidden id="remount-review" onClick={() => setReviewKey((key) => key + 1)}>Remount Review fixture</button>
      <button hidden id="toggle-review-focus" onClick={() => setHasFocusedEntity((value) => !value)}>Toggle fixture focus</button>
      <section id="board" style={{ width: 280 }}>
        <TodoCard todo={todo} relations={[]}
          onToggleResolved={() => setTodo((current) => ({ ...current, status: current.status === 'resolved' ? 'open' : 'resolved' }))}
          onDelete={() => {}}
          onAddRelation={() => {}} onRemoveRelation={() => {}}
          onSave={async (body) => {
            observations.saves.push(body);
            if (observations.fail) throw new Error('Synthetic save failure');
            await frame();
            setTodo((current) => ({ ...current, bodyJson: createPlainCommentDoc(body) }));
          }} />
      </section>
      {(['panel', 'sticky'] as const).map((presentation) => <section key={presentation} id={presentation} style={{ width: 280 }}>
        <ReviewItemCard comment={todo} projectId={todo.projectId} presentation={presentation}
          relations={[{ id: 'first', toKind: 'category', toId: 'Synthetic relation A' }, { id: 'second', toKind: 'category', toId: 'Synthetic relation B' }]}
          onAddRelation={() => {}} onRemoveRelation={() => {}} />
      </section>)}
      <section id="note" style={{ width: 280 }}>
        <ReviewItemCard comment={{ ...todo, id: 'synthetic-note', kind: 'note' }} projectId={todo.projectId} presentation="panel" />
      </section>
      <section id="review-sort" style={{ width: 280, height: 620, display: 'flex' }}>
        <ReviewPanel key={reviewKey} focused={hasFocusedEntity ? { kind: 'node', id: 'synthetic-node' } : { kind: null, id: null }} />
      </section>
    </main>
  </WorkspaceNavigationProvider>;
}

async function run() {
  await frame();
  const checks: Record<string, boolean> = {};
  const check = (name: string, passed: boolean) => { checks[name] = passed; if (!passed) throw new Error(name); };
  const get = (selector: string) => {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) throw new Error(`Missing ${selector}`);
    return element;
  };
  const doubleClick = async (element: HTMLElement) => {
    element.click(); element.click();
    element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
    await frame();
  };
  const key = (key: string, options: KeyboardEventInit = {}) =>
    get('#board textarea').dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }));
  const change = async (text: string) => {
    const textarea = get('#board textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await frame();
  };
  const board = () => get('#board .workspace-list-row');
  await doubleClick(board());
  check('boardDoubleClickFocusesCurrentText', document.activeElement === get('#board textarea') && (document.activeElement as HTMLTextAreaElement).value === 'Check the synthetic timeline');
  await change('Unsaved draft'); key('Escape'); await frame();
  check('escapeCancelsWithoutLeavingWorkbench', !document.querySelector('#board textarea') && observations.saves.length === 0 && observations.escaped === 0);
  await doubleClick(board()); await change('   '); key('Enter', { ctrlKey: true }); await frame();
  check('emptyContentDoesNotSave', observations.saves.length === 0 && !!document.querySelector('#board textarea'));
  await change('更新合成待办\n第二行');
  key('Enter', { metaKey: true, isComposing: true }); key('Escape', { isComposing: true }); await frame();
  check('imeCompositionDoesNotSaveOrCancel', observations.saves.length === 0 && !!document.querySelector('#board textarea') && observations.escaped === 0);
  key('Enter', { metaKey: true }); key('Enter', { metaKey: true }); await frame(); await frame();
  check('shortcutSavesOnceAndUpdatesCard', observations.saves.length === 1 && !document.querySelector('#board textarea') && board().textContent!.includes('更新合成待办'));
  await doubleClick(board());
  check('reopenUsesSavedContent', (get('#board textarea') as HTMLTextAreaElement).value === '更新合成待办 第二行');
  const before = observations.saves.length;
  key('Enter', { ctrlKey: true }); await frame();
  check('unchangedContentDoesNotWrite', observations.saves.length === before && !document.querySelector('#board textarea'));
  await doubleClick(board()); await change('Retry this synthetic draft'); observations.fail = true;
  key('Enter', { ctrlKey: true }); await frame();
  check('failedSavePreservesDraft', (get('#board textarea') as HTMLTextAreaElement).value === 'Retry this synthetic draft' && !!document.querySelector('#board [role="alert"]'));
  observations.fail = false;
  get('#board .review-card__editor-actions button:last-child').click(); await frame(); await frame();
  check('saveButtonRetriesSuccessfully', !document.querySelector('#board textarea') && board().textContent!.includes('Retry this synthetic draft'));
  await doubleClick(get('#board button[title="Delete"]'));
  check('boardActionDoesNotOpenEditor', !document.querySelector('#board textarea'));
  for (const surface of ['panel', 'sticky']) {
    const jumps = observations.jumps;
    await doubleClick(get(`#${surface} .review-card__body`));
    check(`${surface}DoubleClickEditsWithoutJumping`, document.activeElement === get(`#${surface} textarea`) && observations.jumps === jumps);
    check(`${surface}LoadsUpdatedBody`, (get(`#${surface} textarea`) as HTMLTextAreaElement).value === 'Retry this synthetic draft');
    get(`#${surface} .review-card__editor-actions button`).click(); await frame();
    check(`${surface}CancelClosesEditor`, !document.querySelector(`#${surface} textarea`));
    await doubleClick(get(`#${surface} .review-card__text-link-button`));
    check(`${surface}AnchorActionDoesNotEdit`, observations.jumps === jumps + 2 && !document.querySelector(`#${surface} textarea`));
  }
  const jumps = observations.jumps;
  get('#note .review-card__body').click(); await frame();
  check('ordinaryCommentStillJumpsOnClick', observations.jumps === jumps + 1);
  const surfaces = ['board', 'panel', 'sticky'];
  get('#board .todo-status-toggle').click(); await frame();
  check('statusToggleResolvesAndShowsCheck', surfaces.every((surface) => get(`#${surface} .todo-status-toggle`).getAttribute('aria-pressed') === 'true'
    && !!document.querySelector(`#${surface} .todo-status-toggle svg`)) && !document.querySelector('#board textarea'));
  get('#board .todo-status-toggle').click(); await frame();
  check('statusToggleReopensAndShowsEmptyRing', surfaces.every((surface) => get(`#${surface} .todo-status-toggle`).getAttribute('aria-pressed') === 'false'
    && !document.querySelector(`#${surface} .todo-status-toggle svg`)));

  const samples: Record<string, unknown>[] = [];
  const probe = document.createElement('span'); document.body.append(probe);
  const color = (token: string) => { probe.style.color = `hsl(var(${token}))`; return getComputedStyle(probe).color; };
  const luminance = (value: string) => {
    const channels = value.match(/[\d.]+/g)!.slice(0, 3).map((v) => {
      const channel = Number(v) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const contrast = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
  for (const dark of [false, true]) for (const width of [280, 180]) {
    document.documentElement.classList.toggle('dark', dark);
    for (const surface of surfaces) get(`#${surface}`).style.width = `${width}px`;
    await frame();
    for (const surface of surfaces) {
      const button = get(`#${surface} .todo-card__relation-button, #${surface} .entity-relation-picker__add`);
      const relation = button.getBoundingClientRect();
      const toggle = get(`#${surface} .todo-status-toggle`).getBoundingClientRect();
      const border = getComputedStyle(button);
      samples.push({ surface, dark, width, aligned: Math.abs(relation.y + relation.height / 2 - toggle.y - toggle.height / 2) < 0.5,
        right: toggle.left >= relation.right && toggle.right <= get(`#${surface}`).getBoundingClientRect().right,
        dashed: border.borderStyle === 'dashed', contrast: contrast(border.borderColor, color('--paper')), previousContrast: contrast(color('--rule'), color('--paper')) });
    }
  }
  check('footerAlignedAndRelationBorderClearer', samples.every((sample) => sample.aligned && sample.right && sample.dashed && Number(sample.contrast) > Number(sample.previousContrast)));
  probe.remove(); document.documentElement.classList.remove('dark');
  for (const surface of surfaces) get(`#${surface}`).style.width = '280px';
  get('#board .todo-card__relation-button').click(); await frame();
  const expandedRelation = get('#board .entity-relation-picker__add').getBoundingClientRect();
  const expandedToggle = get('#board .todo-status-toggle').getBoundingClientRect();
  check('expandedPickerKeepsToggleAligned', Math.abs(expandedRelation.y + expandedRelation.height / 2 - expandedToggle.y - expandedToggle.height / 2) < 0.5);
  get('#board .entity-relation-picker__add').click(); await frame();
  const cardIds = (selector: string) => [...document.querySelectorAll<HTMLElement>(`#review-sort ${selector}`)].map((card) => card.dataset.commentId).join(',');
  const openIds = () => cardIds('.review-panel__list > article');
  const resolvedIds = () => cardIds('.review-panel__resolved-list > article');
  const resolvedGroup = () => get('#review-sort .review-panel__resolved') as HTMLDetailsElement;
  check('reviewDefaultsToUpdatedOrderAndExpandedResolved', openIds() === 'open-a,open-b' && resolvedIds() === 'resolved-d,resolved-c' && resolvedGroup().open);
  const chooseSort = async (label: string) => {
    get('#review-sort .review-panel__sort-button').click(); await frame();
    const option = [...document.querySelectorAll<HTMLButtonElement>('.sort-menu [role="menuitemradio"]')].find((button) => button.textContent!.trim() === label);
    if (!option) throw new Error(`Missing sort option: ${label}`);
    option.click(); await frame();
  };
  get('#review-sort .review-panel__sort-button').click(); await frame();
  check('reviewUsesSharedPortalSortMenu', !get('.sort-menu').closest('#review-sort') && getComputedStyle(get('.sort-menu')).position === 'fixed'
    && [...document.querySelectorAll('.sort-menu [role="menuitemradio"]')].some((option) => option.textContent!.trim() === 'Updated time' && option.getAttribute('aria-checked') === 'true'));
  get('#review-sort .review-panel__sort-button').click(); await frame();
  await chooseSort('Created time');
  check('reviewCreatedTimeSortsBothGroups', openIds() === 'open-b,open-a' && resolvedIds() === 'resolved-c,resolved-d');
  const persisted = JSON.parse(localStorage.getItem(useUiStore.persist.getOptions().name)!);
  check('reviewSortPreferencePersistsIndependently', persisted.state.reviewSortMode === 'createdAt' && useUiStore.getState().chapterGlobalSortMode === 'bookOrder');
  get('#review-sort .review-panel__resolved > summary').click(); await frame();
  await chooseSort('Updated time');
  check('reviewUpdatedTimeSortPreservesManualCollapse', openIds() === 'open-a,open-b' && resolvedIds() === 'resolved-d,resolved-c' && !resolvedGroup().open);
  get('#review-sort .review-panel__resolved > summary').click(); await frame();
  const storeOptions = useUiStore.persist.getOptions();
  const initialUi = useUiStore.getInitialState();
  check('reviewSortRestoresOlderAndInvalidPreferences', storeOptions.merge!({}, initialUi).reviewSortMode === 'updatedAt'
    && storeOptions.merge!({ reviewSortMode: 'invalid' }, initialUi).reviewSortMode === 'updatedAt'
    && storeOptions.merge!({ reviewSortMode: 'createdAt' }, initialUi).reviewSortMode === 'createdAt');
  check('reviewSortDoesNotMutateSourceCollection', useDataStore.getState().comments.map((comment) => comment.id).join(',') === 'open-a,open-b,resolved-c,resolved-d');
  const scopeToggle = () => get('#review-sort .review-panel__scope-toggle') as HTMLButtonElement;
  const storageName = storeOptions.name;
  const savedScope = () => JSON.parse(localStorage.getItem(storageName)!).state.reviewScope;
  useDataStore.getState().setComments([...reviewComments, { ...reviewComments[0], id: 'other-entity', targetId: 'other-node' }]);
  await frame(); scopeToggle().click(); await frame();
  check('reviewProjectScopeFiltersAndPersists', savedScope() === 'project' && scopeToggle().textContent === 'Project' && openIds().includes('other-entity'));
  get('#remount-review').click(); await frame();
  check('reviewScopeSurvivesPanelRemount', scopeToggle().textContent === 'Project' && openIds().includes('other-entity'));
  const savedUi = localStorage.getItem(storageName)!;
  useUiStore.setState({ reviewScope: 'current' });
  localStorage.setItem(storageName, savedUi);
  await useUiStore.persist.rehydrate(); await frame();
  check('reviewScopeRestoresFromStorage', scopeToggle().textContent === 'Project' && useUiStore.getState().reviewScope === 'project'
    && useUiStore.getState().reviewSortMode === 'updatedAt');
  scopeToggle().click(); await frame();
  get('#toggle-review-focus').click(); await frame();
  const fallbackPreservesPreference = scopeToggle().disabled && scopeToggle().textContent === 'Project' && savedScope() === 'current';
  get('#toggle-review-focus').click(); await frame();
  check('reviewTemporaryProjectFallbackPreservesCurrentPreference', fallbackPreservesPreference && !scopeToggle().disabled
    && scopeToggle().textContent === 'Current' && !openIds().includes('other-entity') && savedScope() === 'current');
  check('reviewScopeRestoresOlderAndInvalidPreferences', storeOptions.merge!({}, initialUi).reviewScope === 'current'
    && storeOptions.merge!({ reviewScope: 'invalid' }, initialUi).reviewScope === 'current'
    && storeOptions.merge!({ reviewScope: 'project' }, initialUi).reviewScope === 'project');
  useDataStore.getState().setComments(reviewComments); await frame();
  const toolbarSamples = [];
  for (const size of ['small', 'standard', 'large']) for (const width of [280, 360]) {
    document.documentElement.dataset.interfaceTextSize = size;
    get('#review-sort').style.width = `${width}px`; await frame();
    const bounds = get('#review-sort .review-panel__toolbar').getBoundingClientRect();
    const controls = [...document.querySelectorAll<HTMLElement>('#review-sort .review-panel__toolbar button')];
    const rects = controls.map((control) => control.getBoundingClientRect());
    toolbarSamples.push({ size, width,
      fits: rects.every((rect) => rect.left >= bounds.left && rect.right <= bounds.right),
      readable: controls.every((control) => control.scrollWidth <= control.clientWidth + 1),
      separate: rects.every((rect, index) => rects.slice(index + 1).every((other) => rect.right <= other.left || other.right <= rect.left || rect.bottom <= other.top || other.bottom <= rect.top)),
    });
  }
  check('reviewToolbarFitsAllDesktopTextSizes', toolbarSamples.every((sample) => sample.fits && sample.readable && sample.separate));
  document.documentElement.dataset.interfaceTextSize = 'standard'; get('#review-sort').style.width = '280px'; await frame();
  const enter = (element: HTMLElement) => element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
  const leave = (element: HTMLElement) => element.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
  const hoverWait = () => new Promise((resolve) => setTimeout(resolve, 260));
  enter(board()); await frame();
  check('sourceHoverWaitsBeforeShowing', !document.querySelector('.comment-source-hover'));
  leave(board()); await hoverWait();
  check('sourceHoverCancelsOnEarlyLeave', !document.querySelector('.comment-source-hover'));
  for (const surface of ['board', 'panel', 'sticky', 'note']) {
    const card = get(`#${surface} .workspace-list-row, #${surface} .review-card`);
    enter(card); await hoverWait(); await frame();
    const tooltip = get('.comment-source-hover');
    check(`${surface}HoverShowsSourceAndSelectedText`, tooltip.textContent!.includes('Chapter') && tooltip.textContent!.includes('The synthetic arrival')
      && tooltip.textContent!.includes('At dawn, the visitor returned.') && !tooltip.textContent!.includes('Full synthetic paragraph')
      && tooltip.id === card.getAttribute('aria-describedby'));
    if (surface === 'panel') check('sourceHoverIncludesAssociatedEntities', tooltip.textContent!.includes('Synthetic relation A') && tooltip.textContent!.includes('Synthetic relation B'));
    check(`${surface}HoverPortalsWithinViewport`, tooltip.parentElement === document.body && getComputedStyle(tooltip).position === 'fixed'
      && tooltip.getBoundingClientRect().right <= innerWidth - 11 && tooltip.getBoundingClientRect().bottom <= innerHeight - 11);
    leave(card); await frame();
  }
  enter(board()); await hoverWait(); await frame();
  const ring = get('#board .todo-status-toggle');
  ring.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); await frame();
  check('sourceHoverDismissesBeforeActions', !document.querySelector('.comment-source-hover'));
  leave(board()); enter(board()); await hoverWait(); await frame();
  await doubleClick(board());
  check('sourceHoverDismissesForEditing', !document.querySelector('.comment-source-hover') && document.activeElement === get('#board textarea'));
  key('Escape'); await frame(); leave(board());
  enter(get('#note article')); await hoverWait(); await frame();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await frame();
  check('sourceHoverDismissesOnEscape', !document.querySelector('.comment-source-hover'));
  leave(get('#note article'));
  useDataStore.getState().setComments(reviewComments.map((comment) => comment.id === 'open-a'
    ? { ...comment, anchorJson: JSON.stringify({ selectedText: Array.from({ length: 60 }, (_, i) => `Synthetic paragraph ${i + 1}`).join('\n') }) } : comment));
  await frame();
  const longCard = get('#review-sort [data-comment-id="open-a"]');
  longCard.scrollIntoView({ block: 'center' }); enter(longCard); await hoverWait(); await frame();
  const longContent = get('.comment-source-hover__content');
  longCard.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true })); await frame();
  check('sourceHoverLongExcerptScrollsWithinViewport', longContent.scrollTop > 0 && longContent.textContent!.includes('Synthetic paragraph 60')
    && get('.comment-source-hover').getBoundingClientRect().height <= 420);
  leave(longCard); useDataStore.getState().setComments(reviewComments); window.scrollTo(0, 0); await frame();
  // Keep a right-edge preview visible for the generated visual inspection.
  get('#note').style.position = 'fixed'; get('#note').style.right = '16px'; get('#note').style.bottom = '16px';
  enter(get('#note article')); await hoverWait(); await frame();
  const edgeTooltip = get('.comment-source-hover').getBoundingClientRect();
  check('sourceHoverFlipsLeftAtRightEdge', edgeTooltip.right <= get('#note article').getBoundingClientRect().left
    && edgeTooltip.bottom <= innerHeight - 11 && edgeTooltip.left >= 11);
  return { status: 'passed', checks, samples, toolbarSamples, boundary: { data: 'synthetic', save: 'in-memory callback', sqlite: 'not_run', nativeInteraction: 'not_run' } };
}

Object.assign(window, { __TODO_EDIT__: { run } });
createRoot(document.getElementById('root')!).render(<Fixture />);
