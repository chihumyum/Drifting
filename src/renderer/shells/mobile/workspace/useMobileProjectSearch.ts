import { useEffect, useMemo, useState } from 'react';
import { sql } from 'drizzle-orm';
import { getDb } from '../../../lib/db';
import { NodeContentTable } from '../../../schema/drizzle';
import { useDataStore } from '../../../store/data-store';
import {
  escapeMobileProjectSearchLike,
  mobileSearchTextFromJson,
  searchMobileProjectPapers,
  type MobileProjectSearchGroup,
  type MobileProjectSearchPaper,
} from './mobile-project-search';

export interface MobileProjectSearchState {
  status: 'idle' | 'searching' | 'ready';
  groups: MobileProjectSearchGroup[];
  totalMatches: number;
}

export function useMobileProjectSearch(query: string): MobileProjectSearchState {
  const bookNodes = useDataStore((state) => state.bookNodes);
  const storylines = useDataStore((state) => state.storylines);
  const elements = useDataStore((state) => state.bookElements);
  const categories = useDataStore((state) => state.bookElementCategories);
  const [state, setState] = useState<MobileProjectSearchState>({
    status: 'idle',
    groups: [],
    totalMatches: 0,
  });

  const metadataPapers = useMemo<MobileProjectSearchPaper[]>(
    () => [
      ...bookNodes.map((node) => ({
        target: { entityType: 'node' as const, id: node.id },
        title: node.title || 'Untitled',
        fields: [
          { field: 'title' as const, text: node.title || '' },
          { field: 'summary' as const, text: node.summary || '' },
        ],
      })),
      ...storylines.map((storyline) => ({
        target: { entityType: 'storyline' as const, id: storyline.id },
        title: storyline.name || 'Untitled',
        fields: [
          { field: 'name' as const, text: storyline.name || '' },
          { field: 'summary' as const, text: storyline.summary || '' },
          { field: 'body' as const, text: mobileSearchTextFromJson(storyline.contentJson) },
        ],
      })),
      ...elements.map((element) => ({
        target: { entityType: 'element' as const, id: element.id },
        title: element.name || 'Untitled',
        fields: [
          { field: 'name' as const, text: element.name || '' },
          { field: 'summary' as const, text: element.summary || '' },
          { field: 'body' as const, text: mobileSearchTextFromJson(element.contentJson) },
        ],
      })),
      ...categories.map((category) => ({
        target: { entityType: 'category' as const, id: category.id },
        title: category.name || 'Untitled',
        fields: [
          { field: 'name' as const, text: category.name || '' },
          { field: 'body' as const, text: mobileSearchTextFromJson(category.contentJson) },
        ],
      })),
    ],
    [bookNodes, categories, elements, storylines],
  );

  useEffect(() => {
    const normalized = query.trim();
    let cancelled = false;
    if (!normalized) {
      queueMicrotask(() => {
        if (!cancelled) setState({ status: 'idle', groups: [], totalMatches: 0 });
      });
      return () => {
        cancelled = true;
      };
    }
    queueMicrotask(() => {
      if (!cancelled) setState((current) => ({ ...current, status: 'searching' }));
    });
    const timer = window.setTimeout(() => {
      void (async () => {
        const nodeBodies = new Map<string, string>();
        try {
          const escaped = escapeMobileProjectSearchLike(normalized);
          const pattern = `%${escaped.toLocaleLowerCase()}%`;
          const rows = await getDb()
            .select({
              nodeId: NodeContentTable.nodeId,
              contentJson: NodeContentTable.contentJson,
            })
            .from(NodeContentTable)
            .where(
              sql`lower(${NodeContentTable.contentJson}) LIKE ${pattern} ESCAPE '\\'`,
            );
          for (const row of rows) {
            if (row.contentJson) nodeBodies.set(row.nodeId, row.contentJson);
          }
        } catch {
          // Metadata search remains available before the native database is ready.
        }
        if (cancelled) return;
        const papers = metadataPapers.map((paper) =>
          paper.target.entityType === 'node'
            ? {
                ...paper,
                fields: [
                  ...paper.fields,
                  {
                    field: 'body' as const,
                    text: mobileSearchTextFromJson(nodeBodies.get(paper.target.id)),
                  },
                ],
              }
            : paper,
        );
        const groups = searchMobileProjectPapers(normalized, papers);
        if (!cancelled) {
          setState({
            status: 'ready',
            groups,
            totalMatches: groups.reduce((sum, group) => sum + group.totalMatches, 0),
          });
        }
      })();
    }, 160);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [metadataPapers, query]);

  return state;
}
