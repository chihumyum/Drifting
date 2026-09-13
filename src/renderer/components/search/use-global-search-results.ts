import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getDb, getDbIfInitialized, type DbClient } from '../../lib/db';
import { useDataStore } from '../../store/data-store';
import { useDataStoreFields } from '../../store/use-data-store-fields';
import { createGlobalSearchIndex, searchGlobalDocuments, type EntityGroup } from './global-search-model';
import { readGlobalSearchNodeBodies } from './global-search-repository';

const EMPTY_GROUPS: EntityGroup[] = [];

/** The mounted modal owns one search session. Snapshot identity prevents an old
 * result from remaining selectable even before passive-effect cleanup runs. */
export function useGlobalSearchResults(projectId: string, query: string): EntityGroup[] {
  const { t } = useTranslation();
  const snapshot = useDataStoreFields('workspaceProjectId', 'workspaceProjectionGeneration',
    'bookNodes', 'storylines', 'bookElements', 'bookElementCategories');
  const input = useMemo(() => ({ token: Symbol('global-search-input'), projectId, query: query.trim(), snapshot,
    labels: { untitled: t('globalSearch.fallback.untitled'), unnamed: t('globalSearch.fallback.unnamed') },
  }), [projectId, query, snapshot, t]);
  const [index] = useState(createGlobalSearchIndex);
  // Retain only an identity token with results, not the entire old workspace snapshot.
  const [result, setResult] = useState<{ token: symbol; groups: EntityGroup[] } | null>(null);

  useEffect(() => () => index.clear(), [index, projectId, snapshot.workspaceProjectionGeneration]);
  useEffect(() => {
    const { workspaceProjectId, workspaceProjectionGeneration } = snapshot;
    if (workspaceProjectId !== projectId || workspaceProjectionGeneration === null) {
      index.clear();
      return;
    }
    if (!input.query) {
      index.clear();
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      let db: DbClient | null = null;
      let bodies = new Map<string, string>();
      try {
        db = getDb();
        bodies = await readGlobalSearchNodeBodies(projectId, input.query, db);
      } catch {
        // Preserve metadata search when the database is unavailable.
      }
      // Check rejection as well as success: neither may start parsing old
      // bodies after close, database replacement or a projection publication.
      const current = useDataStore.getState();
      if (cancelled || getDbIfInitialized() !== db ||
        current.workspaceProjectId !== workspaceProjectId ||
        current.workspaceProjectionGeneration !== workspaceProjectionGeneration ||
        current.bookNodes !== snapshot.bookNodes || current.storylines !== snapshot.storylines ||
        current.bookElements !== snapshot.bookElements || current.bookElementCategories !== snapshot.bookElementCategories) return;
      const documents = index.prepare(JSON.stringify([projectId, workspaceProjectionGeneration]), snapshot, bodies, input.labels);
      setResult({ token: input.token, groups: searchGlobalDocuments(documents, input.query) });
    }, 180);
    return () => { cancelled = true; window.clearTimeout(handle); };
  }, [index, input, projectId, snapshot]);

  return result?.token === input.token ? result.groups : EMPTY_GROUPS;
}
