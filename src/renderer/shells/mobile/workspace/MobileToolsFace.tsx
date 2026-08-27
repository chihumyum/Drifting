import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import type { EntityKind } from '../../../lib/extensions/entity-link';
import { TodoPanel } from '../../../components/rightBars/TodoPanel';
import { LibraryPanel, type FocusedEntity } from '../../../features/library/LibraryPanel';
import { MobileAgentPanel } from './MobileAgentPanel';
import { BottomTimeline } from '../../../components/BottomTimeline/BottomTimeline';
import { useMobilePaperPresentation } from './MobilePaperContent';
import { usePaperGlyph } from './mobile-paper-glyph';

type ToolTab = 'planning' | 'agent' | 'library';
type LibraryMode = 'todo' | 'library';

function focusedEntity(target: WorkspaceTarget | null): FocusedEntity {
  if (!target || target.entityType === 'all-chapters') {
    return { kind: null, id: null };
  }
  return { kind: target.entityType as EntityKind, id: target.id };
}

/** The project's full-screen tool face — the desktop right bar's home on
 * mobile, opened from the paper's top-right control: 时间线 · Agent ·
 * 素材库(TODO/资料). Paper-bound tools live behind the tab bar's ⁂ entry. */
export function MobileToolsFace({
  projectId,
  target,
  onClose,
}: {
  projectId: string;
  target: WorkspaceTarget;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<ToolTab>('planning');
  const [libraryMode, setLibraryMode] = useState<LibraryMode>('todo');
  const presentation = useMobilePaperPresentation(target);
  const glyph = usePaperGlyph(target);
  const focused = focusedEntity(target);
  const tabs = [
    ['planning', t('bottomTimeline.title', { defaultValue: '时间线' })],
    ['agent', 'Agent'],
    ['library', t('rightSidebar.tabs.library')],
  ] as const;

  return (
    <section
      className="m-tools-face"
      role="dialog"
      aria-modal="true"
      data-debug-id="mobile-tools-face"
      aria-label={t('mobileWorkspace.tools', { defaultValue: '工具工作区' })}
    >
      <header className="m-tools-face__header">
        <span className="m-tools-face__identity">
          <span aria-hidden="true">{glyph}</span> {presentation.title}
        </span>
        <nav className="m-tools-face__tabs" aria-label={t('mobileWorkspace.tools', { defaultValue: '工具工作区' })}>
          {tabs.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-current={tab === id ? 'page' : undefined}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
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
      <div className="m-tools-face__pane">
        {tab === 'planning' && (
          <div className="m-context-workspace__pane m-context-workspace__body">
            <div className="m-bottom-timeline">
              <BottomTimeline presentation="mobile" />
            </div>
          </div>
        )}
        {tab === 'agent' && (
          <div className="m-context-workspace__pane m-context-workspace__body">
            <MobileAgentPanel projectId={projectId} target={target} />
          </div>
        )}
        {tab === 'library' && (
          <>
            <header className="m-tool-workspace__subtabs">
              <button
                type="button"
                aria-current={libraryMode === 'todo' ? 'page' : undefined}
                onClick={() => setLibraryMode('todo')}
              >
                TODO
              </button>
              <button
                type="button"
                aria-current={libraryMode === 'library' ? 'page' : undefined}
                onClick={() => setLibraryMode('library')}
              >
                {t('rightSidebar.tabs.library')}
              </button>
            </header>
            <div
              className="m-context-workspace__pane m-context-workspace__body m-library-workspace"
              data-mobile-library={libraryMode}
            >
              {libraryMode === 'todo' ? (
                <TodoPanel focused={focused} />
              ) : (
                <LibraryPanel focused={focused} presentation="mobile" />
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
