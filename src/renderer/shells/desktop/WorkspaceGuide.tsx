import { useEffect, useState } from 'react';
import { afterEditorStageReady } from '../../components/editor/editor-stage-ready';
import { CoachTour } from '../../features/guide/CoachTour';
import { WORKSPACE_TOUR, WORKSPACE_TOUR_ID } from '../../features/guide/workspace-tour';
import { useSettingsStore } from '../../store/settings-store';
import { useUiStore } from '../../store/ui-store';
import { useWorkspaceOpeningCovered } from './useWorkspaceOpening';

/** After the book has come up from under the opening wait, the tour waits this long more. */
export const WORKSPACE_TOUR_DELAY_MS = 700;
const STAGE_READY_LIMIT_MS = 3000;

/**
 * The workspace tour, the first time a book opens on this device: once the
 * page in front is ready and the opening wait has lifted. A Super View puts
 * it away; it starts again from the top when the Super View closes. Finishing
 * or skipping it marks it seen (Settings → Appearance can show it again).
 */
export function WorkspaceGuide() {
  const seen = useSettingsStore((state) => state.guidesSeen.includes(WORKSPACE_TOUR_ID));
  const markGuideSeen = useSettingsStore((state) => state.markGuideSeen);
  const covered = useWorkspaceOpeningCovered();
  const superView = useUiStore((state) => state.activeSuperView);
  const [stageReady, setStageReady] = useState(false);
  const [due, setDue] = useState(false);

  useEffect(() => {
    if (seen) return undefined;
    return afterEditorStageReady(() => setStageReady(true), STAGE_READY_LIMIT_MS);
  }, [seen]);

  useEffect(() => {
    if (seen || due || !stageReady || covered || superView !== 'none') return undefined;
    const timer = window.setTimeout(() => setDue(true), WORKSPACE_TOUR_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [covered, due, seen, stageReady, superView]);

  if (seen || !due || superView !== 'none') return null;
  return <CoachTour steps={WORKSPACE_TOUR} onDone={() => markGuideSeen(WORKSPACE_TOUR_ID)} />;
}
