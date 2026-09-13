import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { GlobalSearchModal } from '../components/search/GlobalSearchModal';
import { WorkspaceNavigationProvider } from '../features/workspace/navigation/WorkspaceNavigationContext';
import type { WorkspaceNavigator, WorkspaceTarget } from '../features/workspace/navigation/workspace-target';
import { installHeadlessDatabaseClient } from '../lib/db';
import * as schema from '../schema/drizzle';
import { useDataStore } from '../store/data-store';
import { createWorkspaceSharingFixture } from './workspace-fixture';

declare global { var __GLOBAL_SEARCH_COUNTS__: { parses: number; groups: number }; }
const wait = (ms = 240) => new Promise(resolve => setTimeout(resolve, ms));
const body = (text: string) => JSON.stringify({ type: 'doc', content: [{ type: 'text', text }] });
function dataFor(projectId: string, count: number) {
  const data = createWorkspaceSharingFixture(projectId, 1);
  data.storylines = []; data.bookElementCategories = [];
  data.bookNodes[0] = { ...data.bookNodes[0], title: 'Synthetic chapter', summary: '' };
  data.bookElements = Array.from({ length: count }, (_, index) => ({ ...data.bookElements[0],
    id: `element-${index}`, name: `Synthetic element ${index}`, summary: '', contentJson: body(`needle target ${index}`),
  }));
  return data;
}

/** Actual mounted product modal and Zustand; only the asynchronous database
 * read port is synthetic here. SQL correctness is tested against real SQLite. */
export async function runGlobalSearchScenario() {
  const saved = useDataStore.getState(); const profiles = [];
  const translation = i18next.createInstance(); await translation.init({ lng: 'en', resources: { en: { translation: {} } } });
  for (const count of [100, 1000, 5000]) {
    let reads = 0; const sqlQueries: string[] = [];
    let defer = false;
    const pending: Array<{ resolve(): void; reject(): void }> = [];
    const db = drizzle(async (sql) => {
      reads++; sqlQueries.push(sql);
      if (defer) await new Promise<void>((resolve, reject) => pending.push({ resolve, reject: () => reject(new Error('Synthetic rejected read')) }));
      return { rows: [] };
    }, { schema });
    let uninstall = installHeadlessDatabaseClient(db, 'synthetic-search.db');
    let projectId = 'synthetic-search-a'; let generation = 'generation-1'; let data = dataFor(projectId, count);
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    let isOpen = true; const opened: WorkspaceTarget[] = [];
    const navigator = (): WorkspaceNavigator => ({ projectId, open: target => { opened.push(target); }, activate() {}, showProjectHome() {}, leaveDeletedTarget() {} });
    const render = () => flushSync(() => root.render(<I18nextProvider i18n={translation}><WorkspaceNavigationProvider navigator={navigator()}>
      <GlobalSearchModal isOpen={isOpen} onClose={() => { isOpen = false; render(); }} />
    </WorkspaceNavigationProvider></I18nextProvider>));
    const publish = () => flushSync(() => {
      const epoch = useDataStore.getState().requestWorkspaceProjection(projectId, 'refreshing');
      useDataStore.getState().commitWorkspaceProjection(projectId, epoch, data, undefined, generation);
    });
    const input = () => container.querySelector<HTMLInputElement>('.gsearch-input');
    const type = (value: string) => {
      const field = input(); if (!field) throw new Error('Search input missing');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
      flushSync(() => field.dispatchEvent(new Event('input', { bubbles: true })));
    };
    const key = (value: string) => flushSync(() => input()?.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })));
    const reset = () => { reads = 0; globalThis.__GLOBAL_SEARCH_COUNTS__ = { parses: 0, groups: 0 }; };
    const measure = () => ({ reads, ...globalThis.__GLOBAL_SEARCH_COUNTS__ });
    const groupCount = () => container.querySelectorAll('.gsearch-group').length;
    const resolveAll = (reject = false) => { for (const item of pending.splice(0)) { if (reject) item.reject(); else item.resolve(); } };
    try {
      publish(); render(); await wait(20); reset(); type('needle'); await wait();
      const initial = measure(); const initialResults = groupCount() === count; reset();
      for (const query of ['target', 'needle']) { type(query); await wait(); }
      const repeatedQueries = measure(); reset();
      data.bookElements = data.bookElements.map((element, index) => index === 0 ? { ...element, name: 'Renamed synthetic element' } : element); publish(); await wait();
      const rename = measure(); reset();
      data.bookElements = data.bookElements.map((element, index) => index === 0 ? { ...element, contentJson: body('needle changed body') } : element); publish(); await wait();
      const changedBody = measure(); reset();
      generation = 'generation-2'; publish(); await wait(); const generationChange = measure(); reset();
      isOpen = false; render();
      for (let index = 0; index < 10; index++) {
        data.bookNodes = data.bookNodes.map(node => ({ ...node, wordCount: index + 1 })); publish(); await wait();
      }
      const hidden = measure(); reset();
      isOpen = true; render(); await wait(20); const reopenedEmpty = input()?.value === '' && groupCount() === 0;
      type('needle'); await wait(); const reopened = measure();
      // Rejected late replies must not parse the closed session's bodies.
      defer = true; type('target'); await wait(); isOpen = false; render(); reset(); resolveAll(true); await wait();
      const lateClosedRejection = measure();
      // Successful old-project reply after A -> B -> A must not publish or parse.
      isOpen = true; render(); await wait(20); type('needle'); await wait();
      projectId = 'synthetic-search-b'; data = dataFor(projectId, count); generation = 'generation-b'; publish(); render(); await wait(20);
      projectId = 'synthetic-search-a'; data = dataFor(projectId, count); generation = 'generation-3'; publish(); render(); await wait();
      reset(); resolveAll(); await wait(20); const projectReturnClearsQuery = input()?.value === '' && groupCount() === 0;
      const lateProjectReply = measure();
      defer = false; type('needle'); await wait(); const projectReturnRecovers = groupCount() === count;
      // Committed generation invalidates displayed rows synchronously, while a
      // pending refresh with unchanged committed data leaves them usable.
      flushSync(() => useDataStore.getState().requestWorkspaceProjection(projectId, 'refreshing'));
      const pendingRefreshRetainsResults = groupCount() === count;
      defer = true; generation = 'generation-4'; publish();
      const generationHidesOldResults = groupCount() === 0;
      key('Enter'); const generationCannotOpenOldResult = opened.length === 0;
      await wait(); reset(); resolveAll(); await wait(20);
      const generationRecovers = input()?.value === 'needle' && groupCount() === count;
      const newGeneration = measure();
      // Keyboard navigation still resolves the second displayed entity.
      key('ArrowDown'); key('Enter');
      const keyboardOpensCurrent = opened[opened.length - 1]?.entityType === 'element' && opened[opened.length - 1]?.id === 'element-1' && !input();
      isOpen = true; render(); await wait(20);
      // Two pending reads for different committed generations. The old failure
      // must not enter the model, and only the replacement may publish.
      type('needle'); await wait(); const oldGeneration = pending.splice(0);
      generation = 'generation-5'; publish(); await wait(); reset();
      for (const item of oldGeneration) item.reject(); await wait(20);
      const lateGenerationRejection = measure(); const generationRejectStaysEmpty = groupCount() === 0;
      resolveAll(); await wait(20); const replacementGenerationCompletes = groupCount() === count;
      // Metadata fallback after a current read failure remains available.
      type('element 0'); await wait(); resolveAll(true); await wait(20);
      const readFailureKeepsMetadata = groupCount() === 1;
      // Changing the database while a query is in flight rejects its old result.
      type('target'); await wait(); reset();
      const replacementDb = drizzle(async () => ({ rows: [] }), { schema });
      uninstall();
      const restoreDb = installHeadlessDatabaseClient(replacementDb, 'synthetic-replacement.db');
      let databaseReplacement;
      try { resolveAll(); await wait(20); databaseReplacement = { ...measure(), hidesOldResults: groupCount() === 0 }; }
      finally { restoreDb(); uninstall = installHeadlessDatabaseClient(db, 'synthetic-search.db'); }
      // Loading has no committed projection; typing waits without a DB read.
      flushSync(() => useDataStore.getState().requestWorkspaceProjection(projectId, 'loading'));
      type('needle'); reset(); await wait(); const loading = measure(); const loadingHidesResults = groupCount() === 0;
      defer = false; publish(); await wait(); const loadingPreservesQuery = input()?.value === 'needle' && groupCount() === count;
      key('Escape'); const escapeCloses = !input();
      profiles.push({ elements: count, initial, repeatedQueries, rename, changedBody, generationChange, hidden, reopened,
        lateClosedRejection, lateProjectReply, newGeneration, lateGenerationRejection, databaseReplacement, loading, checks: { initialResults, reopenedEmpty, projectReturnClearsQuery,
          projectReturnRecovers, pendingRefreshRetainsResults, generationHidesOldResults, generationCannotOpenOldResult,
          generationRecovers, keyboardOpensCurrent, generationRejectStaysEmpty, replacementGenerationCompletes, readFailureKeepsMetadata, loadingHidesResults, loadingPreservesQuery, escapeCloses },
        databaseScope: { readsObserved: sqlQueries.length, allProjectScoped: sqlQueries.every(sql => sql.includes('"book_node"."project_id"') && sql.includes('"book_node"."deleted_at"')) } });
    } finally { resolveAll(true); flushSync(() => root.unmount()); container.remove(); uninstall(); useDataStore.setState(saved, true); }
  }
  return { build: 'production-React-mounted-global-search-Chromium', profiles,
    boundary: 'Actual modal, input events, navigation and store publications; synthetic async DB port. Separate real SQLite integration. No native/physical-input/device-budget claim.' };
}
