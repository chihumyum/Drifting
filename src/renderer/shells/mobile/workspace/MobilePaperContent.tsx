import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import { useDataStore } from '../../../store/data-store';
import { isDrift } from '../../../domain/book-node';
import { NodeEditorView } from '../../../views/NodeEditorView';
import { StorylineEditorView } from '../../../views/StorylineEditorView';
import { ElementEditorView } from '../../../views/ElementEditorView';
import { CategoryEditorView } from '../../../views/CategoryEditorView';
import { AllChaptersEditorView } from '../../../views/AllChaptersEditorView';
import { ProjectDashboard } from '../../../views/ProjectDashboard';

export interface MobilePaperPresentation {
  title: string;
  kicker: string;
  preview: string;
  color?: string;
}

export function useMobilePaperPresentation(target: WorkspaceTarget): MobilePaperPresentation {
  const { t } = useTranslation();
  const { bookNodes, storylines, bookElements, bookElementCategories } = useDataStore();
  return useMemo(() => {
    switch (target.entityType) {
      case 'node': {
        const node = bookNodes.find((item) => item.id === target.id);
        const drift = node ? isDrift(node) : false;
        return {
          title: node?.title || t('common.untitled'),
          kicker: drift ? t('leftSidebar.tabs.drifts') : t('leftSidebar.tabs.chapters'),
          preview: node?.summary || t('editorMainArea.emptyHint'),
        };
      }
      case 'storyline': {
        const storyline = storylines.find((item) => item.id === target.id);
        return {
          title: storyline?.name || t('topTimeline.untitled.storyline'),
          kicker: t('dashboard.structure.storylines'),
          preview: storyline?.summary || '',
          color: storyline?.color,
        };
      }
      case 'element': {
        const element = bookElements.find((item) => item.id === target.id);
        const category = bookElementCategories.find((item) => item.id === element?.categoryId);
        return {
          title: element?.name || t('topTimeline.untitled.element'),
          kicker: category?.name || t('leftSidebar.tabs.elements'),
          preview: element?.summary || '',
          color: category?.color,
        };
      }
      case 'category': {
        const category = bookElementCategories.find((item) => item.id === target.id);
        return {
          title: category?.name || target.id,
          kicker: t('leftSidebar.tabs.elements'),
          preview: t('dashboard.structure.elements', {
            count: bookElements.filter((item) => item.categoryId === target.id).length,
          }),
          color: category?.color,
        };
      }
      case 'all-chapters':
        return {
          title: t('rightSidebar.targets.allChapters'),
          kicker: t('topTimeline.tabs.allChapters', { defaultValue: '通览全书' }),
          preview: t('rightSidebar.kickers.allChapters'),
        };
      case 'dashboard':
        return {
          title: t('rightSidebar.targets.dashboard'),
          kicker: 'Drifting',
          preview: t('dashboard.subtitle', { defaultValue: '项目概览' }),
        };
    }
  }, [bookElementCategories, bookElements, bookNodes, storylines, t, target]);
}

export function MobilePaperContent({ target }: { target: WorkspaceTarget }) {
  switch (target.entityType) {
    case 'node':
      return <NodeEditorView key={target.id} nodeIdOverride={target.id} />;
    case 'storyline':
      return <StorylineEditorView key={target.id} storylineIdOverride={target.id} />;
    case 'element':
      return <ElementEditorView key={target.id} elementIdOverride={target.id} />;
    case 'category':
      return <CategoryEditorView key={target.id} categoryIdOverride={target.id} />;
    case 'all-chapters':
      return <AllChaptersEditorView />;
    case 'dashboard':
      return <ProjectDashboard />;
  }
}
