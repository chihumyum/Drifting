import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import { PlotGridEditor } from '../../../components/editor/PlotGrid';
import {
  clonePlotGrid,
  diffPlotGrid,
  readPlotGridProjection,
  type PlotGrid,
  type PlotGridMutation,
} from '../../../domain/plot-grid';
import { useBookContent } from '../../../usecase/useBookContent';
import { useAuthStore } from '../../../store/auth';
import { useMobilePaperPresentation } from './MobilePaperContent';
import { usePaperGlyph } from './mobile-paper-glyph';

function MobilePlotPlannerWorkspace({
  projectId,
  target,
}: {
  projectId: string;
  target: WorkspaceTarget | null;
}) {
  const { t } = useTranslation();
  const userId = useAuthStore((state) => state.user?.id) ?? '';
  const { getContentByNodeId, updatePlotGridByNodeId } = useBookContent({ userId, projectId });
  const nodeId = target?.entityType === 'node' ? target.id : null;
  const [initialJson, setInitialJson] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInitialJson(null);
    if (!nodeId) return () => undefined;
    void getContentByNodeId(nodeId).then(
      (content) => {
        if (active) setInitialJson(content?.plotGridJson ?? '{}');
      },
      () => {
        if (active) setInitialJson('{}');
      },
    );
    return () => {
      active = false;
    };
  }, [getContentByNodeId, nodeId]);

  if (!nodeId) {
    return (
      <div className="m-tool-empty">
        {t('mobileWorkspace.plotNeedsNode', {
          defaultValue: '打开章节或灵感纸张后编辑情节网格。',
        })}
      </div>
    );
  }
  if (initialJson === null) {
    return <div className="m-tool-empty">{t('common.loading', { defaultValue: '加载中…' })}</div>;
  }
  return (
    <div className="m-plot-workspace">
      <MobileNormalizedPlotGridEditor
        key={nodeId}
        nodeId={nodeId}
        initialJson={initialJson}
        onPersist={updatePlotGridByNodeId}
      />
    </div>
  );
}

function MobileNormalizedPlotGridEditor({
  nodeId,
  initialJson,
  onPersist,
}: {
  nodeId: string;
  initialJson: string;
  onPersist: (nodeId: string, mutations: readonly PlotGridMutation[]) => Promise<unknown>;
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const committedGridRef = useRef<PlotGrid | null>(readPlotGridProjection(initialJson));
  const latestGridRef = useRef<PlotGrid | null>(null);
  const persistChainRef = useRef<Promise<void>>(Promise.resolve());
  const onPersistRef = useRef(onPersist);
  useEffect(() => {
    onPersistRef.current = onPersist;
  }, [onPersist]);

  const flush = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    if (!latestGridRef.current) return;
    const target = clonePlotGrid(latestGridRef.current);
    latestGridRef.current = null;
    persistChainRef.current = persistChainRef.current
      .then(async () => {
        const mutations = diffPlotGrid(committedGridRef.current, target);
        if (mutations.length > 0) await onPersistRef.current(nodeId, mutations);
        committedGridRef.current = target;
      })
      .catch((error) => {
        console.error('[PlotGrid] normalized mobile persistence failed:', error);
      });
  }, [nodeId]);

  useEffect(() => flush, [flush]);

  return (
    <PlotGridEditor
      initialJson={initialJson}
      onChange={(grid) => {
        latestGridRef.current = clonePlotGrid(grid);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(flush, 400);
      }}
    />
  );
}

/** The paper-bound tool face behind the tab bar's ⁂ entry: everything wired
 * to the open paper itself — 大纲 and 批注 rail sheets, find-in-paper, 统计,
 * and the 情节规划器 as the face's body. */
export function MobilePaperTools({
  projectId,
  target,
  onClose,
  onOpenStats,
  onOpenSheet,
  onOpenSearch,
}: {
  projectId: string;
  target: WorkspaceTarget;
  onClose: () => void;
  onOpenStats: () => void;
  onOpenSheet: (sheet: 'outline' | 'comments' | 'actions') => void;
  onOpenSearch: () => void;
}) {
  const { t } = useTranslation();
  const presentation = useMobilePaperPresentation(target);
  const glyph = usePaperGlyph(target);
  const handoffs = [
    [t('mobileWorkspace.toolsFace.outline', { defaultValue: '大纲' }), () => onOpenSheet('outline')],
    [t('mobileWorkspace.toolsFace.comments', { defaultValue: '批注' }), () => onOpenSheet('comments')],
    [t('mobileWorkspace.search.open', { defaultValue: '搜索' }), onOpenSearch],
    [t('rightSidebar.tabs.stats', { defaultValue: '统计' }), onOpenStats],
  ] as const;

  return (
    <section
      className="m-tools-face"
      role="dialog"
      aria-modal="true"
      data-debug-id="mobile-paper-tools"
      aria-label={t('mobileWorkspace.paperTools', { defaultValue: '本纸' })}
    >
      <header className="m-tools-face__header">
        <span className="m-tools-face__identity">
          <span aria-hidden="true">{glyph}</span> {presentation.title}
        </span>
        <nav className="m-tools-face__tabs" aria-hidden="true">
          <button type="button" aria-current="page" tabIndex={-1}>
            {t('editorTopBar.actions.plotPlanner', { defaultValue: '情节' })}
          </button>
        </nav>
        <button
          type="button"
          className="m-tools-face__close"
          onClick={onClose}
          aria-label={t('findPanel.closeTitle')}
        >
          <X size={17} aria-hidden="true" />
        </button>
      </header>
      <div className="m-tools-face__handoffs">
        {handoffs.map(([label, run]) => (
          <button key={label} type="button" onClick={run}>
            {label}
          </button>
        ))}
      </div>
      <div className="m-tools-face__pane">
        <div className="m-context-workspace__pane m-context-workspace__body">
          <MobilePlotPlannerWorkspace key={target.id} projectId={projectId} target={target} />
        </div>
      </div>
    </section>
  );
}
