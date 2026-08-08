import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BookOpen,
  PanelsTopLeft,
  Settings,
  Trash2,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MobilePaper, MobileWorkspaceSessionState } from './mobile-workspace-session';
import { useMobilePaperPresentation } from './MobilePaperContent';

export type MobileSuperViewId = 'element' | 'graph' | 'memo-material';

function PaperOverviewCard({
  paper,
  active,
  index,
  count,
  onActivate,
  onClose,
  onMove,
}: {
  paper: MobilePaper;
  active: boolean;
  index: number;
  count: number;
  onActivate: () => void;
  onClose: () => void;
  onMove: (to: number) => void;
}) {
  const presentation = useMobilePaperPresentation(paper.target);
  return (
    <article className="m-tab-card" data-active={active ? 'true' : 'false'}>
      <button type="button" className="m-tab-card__main" onClick={onActivate}>
        <span style={{ background: presentation.color || 'hsl(var(--ink-4))' }} />
        <small>{presentation.kicker}</small>
        <strong>{presentation.title}</strong>
        <p>{presentation.preview}</p>
      </button>
      <div className="m-tab-card__actions">
        <button
          type="button"
          disabled={index === 0}
          onClick={() => onMove(index - 1)}
          aria-label="Move earlier"
        >
          <ArrowUp size={16} />
        </button>
        <button
          type="button"
          disabled={index === count - 1}
          onClick={() => onMove(index + 1)}
          aria-label="Move later"
        >
          <ArrowDown size={16} />
        </button>
        <button type="button" onClick={onClose} aria-label="Close paper">
          <X size={17} />
        </button>
      </div>
    </article>
  );
}

export function MobileTabOverview({
  session,
  onClose,
  onActivate,
  onClosePaper,
  onCloseAll,
  onReorder,
  onOpenSuperView,
  onOpenAllChapters,
  onOpenSettings,
  onBackToShelf,
}: {
  session: MobileWorkspaceSessionState;
  onClose: () => void;
  onActivate: (paper: MobilePaper) => void;
  onClosePaper: (key: string) => void;
  onCloseAll: () => void;
  onReorder: (from: number, to: number) => void;
  onOpenSuperView: (view: MobileSuperViewId) => void;
  onOpenAllChapters: () => void;
  onOpenSettings: () => void;
  onBackToShelf: () => void;
}) {
  const { t } = useTranslation();
  const superViews: Array<{ id: MobileSuperViewId; label: string; meta: string }> = [
    { id: 'element', label: t('superElement.title'), meta: t('leftSidebar.tabs.elements') },
    { id: 'graph', label: t('storyGraph.title'), meta: t('dashboard.structure.storylines') },
    {
      id: 'memo-material',
      label: t('memoMaterial.super.title'),
      meta: t('rightSidebar.tabs.library'),
    },
  ];
  return (
    <section
      className="m-tab-overview"
      role="dialog"
      aria-modal="true"
      aria-label={t('mobileWorkspace.openPapers', { defaultValue: '打开的纸张' })}
    >
      <header>
        <button type="button" onClick={onClose} aria-label={t('navigation.back')}>
          <ArrowLeft size={20} />
        </button>
        <div>
          <span>Drifting</span>
          <strong>{t('mobileWorkspace.openPapers', { defaultValue: '打开的纸张' })}</strong>
        </div>
        <button type="button" onClick={onOpenSettings} aria-label={t('settings.title')}>
          <Settings size={19} />
        </button>
      </header>

      <div className="m-tab-overview__scroll">
        <section className="m-tab-overview__super">
          <div>
            <span>SUPER VIEW</span>
            <small>{t('mobileWorkspace.projectPanoramas', { defaultValue: '项目全景' })}</small>
          </div>
          <div>
            {superViews.map((view) => (
              <button key={view.id} type="button" onClick={() => onOpenSuperView(view.id)}>
                <PanelsTopLeft size={18} aria-hidden="true" />
                <strong>{view.label}</strong>
                <small>{view.meta}</small>
              </button>
            ))}
          </div>
        </section>

        <section className="m-tab-overview__papers">
          <header>
            <span>{session.papers.length} PAPERS</span>
            <div>
              {session.papers.length > 0 && (
                <button type="button" onClick={onCloseAll}>
                  <Trash2 size={15} />
                  {t('mobileWorkspace.closeAll', { defaultValue: '全部关闭' })}
                </button>
              )}
              <button type="button" onClick={onOpenAllChapters}>
                <BookOpen size={16} />
                {t('topTimeline.tabs.allChapters', { defaultValue: '通览全书' })}
              </button>
            </div>
          </header>
          <div>
            {session.papers.map((paper, index) => (
              <PaperOverviewCard
                key={paper.key}
                paper={paper}
                active={paper.key === session.activeKey}
                index={index}
                count={session.papers.length}
                onActivate={() => onActivate(paper)}
                onClose={() => onClosePaper(paper.key)}
                onMove={(to) => onReorder(index, to)}
              />
            ))}
          </div>
        </section>
      </div>

      <footer>
        <button type="button" onClick={onBackToShelf}>
          {t('projectPicker.backToShelf', { defaultValue: '返回书架' })}
        </button>
      </footer>
    </section>
  );
}
