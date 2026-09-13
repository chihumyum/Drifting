import { memo } from 'react';
import { DesktopSettingsModal } from '../../features/settings/desktop/DesktopSettingsModal';
import { ImportDialog } from '../../components/modals/ImportDialog';
import { EntitySnapshotHistoryModal } from '../../components/modals/EntitySnapshotHistoryModal';
import { DriftBindModal } from '../../components/modals/DriftBindModal';
import { EditChapterStorylineModal } from '../../components/modals/EditChapterStorylineModal';
import { GlobalSearchModal } from '../../components/search/GlobalSearchModal';
import { DeferredStoryGraphView as DesktopStoryGraphView, DeferredElementGraphView as DesktopSuperElementView } from './views/DeferredSuperViews';
import { DeferredMemoMaterialView as DesktopSuperMemoMaterialView } from './views/DeferredSuperViews';

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

export const DesktopOverlayHost = memo(function DesktopOverlayHost({
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
});
