import { AgentConfirmDialog } from '../../components/agent/AgentConfirmDialog';
import { DesktopSettingsModal } from '../../features/settings/desktop/DesktopSettingsModal';
import { ImportDialog } from '../../components/modals/ImportDialog';
import { EntitySnapshotHistoryModal } from '../../components/modals/EntitySnapshotHistoryModal';
import { DriftBindModal } from '../../components/modals/DriftBindModal';
import { EditChapterStorylineModal } from '../../components/modals/EditChapterStorylineModal';
import { GlobalSearchModal } from '../../components/search/GlobalSearchModal';
import { DesktopStoryGraphView } from './views/DesktopStoryGraphView';
import { DesktopSuperElementView } from './views/DesktopSuperElementView';
import { DesktopSuperMemoMaterialView } from './views/DesktopSuperMemoMaterialView';

type DesktopSuperView = 'none' | 'element' | 'graph' | 'memo-material';

interface DesktopOverlayHostProps {
  activeSuperView: DesktopSuperView;
  isSettingsOpen: boolean;
  settingsTargetRail: string | null;
  onCloseSettings: () => void;
  isImportOpen: boolean;
  onCloseImport: () => void;
  chapterStorylineEditorNodeId: string | null;
  onCloseChapterStorylineEditor: () => void;
  isGlobalSearchOpen: boolean;
  onCloseGlobalSearch: () => void;
}

export function DesktopOverlayHost({
  activeSuperView,
  isSettingsOpen,
  settingsTargetRail,
  onCloseSettings,
  isImportOpen,
  onCloseImport,
  chapterStorylineEditorNodeId,
  onCloseChapterStorylineEditor,
  isGlobalSearchOpen,
  onCloseGlobalSearch,
}: DesktopOverlayHostProps) {
  return (
    <>
      <AgentConfirmDialog />
      {activeSuperView === 'graph' && <DesktopStoryGraphView />}
      {activeSuperView === 'element' && <DesktopSuperElementView />}
      {activeSuperView === 'memo-material' && <DesktopSuperMemoMaterialView />}
      <DesktopSettingsModal
        isOpen={isSettingsOpen}
        initialRailId={settingsTargetRail}
        onClose={onCloseSettings}
      />
      <ImportDialog open={isImportOpen} onClose={onCloseImport} />
      <EntitySnapshotHistoryModal />
      <DriftBindModal />
      {chapterStorylineEditorNodeId && (
        <EditChapterStorylineModal
          nodeId={chapterStorylineEditorNodeId}
          onClose={onCloseChapterStorylineEditor}
        />
      )}
      <GlobalSearchModal isOpen={isGlobalSearchOpen} onClose={onCloseGlobalSearch} />
    </>
  );
}
