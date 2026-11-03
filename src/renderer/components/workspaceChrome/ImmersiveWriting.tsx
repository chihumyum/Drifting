import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { BrushIcon } from '../ui/BrushIcon';
import { GhostIconButton } from '../ui/GhostIconButton';
import { useTimelineToggleHostedByEditor } from '../editor/editor-corner';
import { useTodayWords } from './useTodayWords';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { formatAccelerator } from '../../lib/shortcuts';
import { useShortcutsStore } from '../../store/shortcuts-store';
import { useUiStore } from '../../store/ui-store';
import { toggleImmersiveWriting } from './immersive-writing';

/**
 * Immersive writing's own round glass button, the oil lamp, to the left of
 * the timeline toggle in the corner that carries it (EditorTopBar). While
 * immersed the rest of the corner is gone and this button stays where it
 * was, pressed, shown only while the pointer is near it, with this sitting's
 * words to its left (immersive-writing.css).
 */
export function ImmersiveWritingControl({ stage = false }: { stage?: boolean }) {
  const immersive = useUiStore((state) => state.immersiveWriting);
  return (
    <div className={`immersive-writing-control${stage ? ' immersive-writing-control--stage' : ''}`}>
      {immersive && <SittingWords />}
      <ImmersiveWritingToggle immersive={immersive} />
    </div>
  );
}

/** With no editor corner showing (Project Home), the stage keeps the way out while immersed. */
export function StageImmersiveWritingControl() {
  const hostedByEditor = useTimelineToggleHostedByEditor();
  const immersive = useUiStore((state) => state.immersiveWriting);
  return immersive && !hostedByEditor ? <ImmersiveWritingControl stage /> : null;
}

function ImmersiveWritingToggle({ immersive }: { immersive: boolean }) {
  const { t } = useTranslation();
  const accelerator = useShortcutsStore((state) => state.bindings.toggleImmersiveWriting);
  const label = t(immersive ? 'immersiveWriting.leave' : 'immersiveWriting.enter');
  return (
    <GhostIconButton
      glass="round"
      className="workspace-immersive-toggle glass--rest"
      aria-pressed={immersive}
      aria-label={label}
      title={`${label} · ${formatAccelerator(accelerator)}`}
      onClick={toggleImmersiveWriting}
      icon={<BrushIcon name="oil-lamp" />}
    />
  );
}

/**
 * This sitting's words over today's sand stroke toward the daily goal. The
 * words already written today when the sitting began are not this sitting's.
 */
function SittingWords() {
  const { projectId } = useProjectNavigation();
  const { todayWords, progress } = useTodayWords(projectId);
  const baseline = useUiStore((state) => state.immersiveWritingBaseline);
  const setBaseline = useUiStore((state) => state.setImmersiveWritingBaseline);
  useEffect(() => {
    if (baseline == null && todayWords != null) setBaseline(todayWords);
  }, [baseline, setBaseline, todayWords]);
  if (todayWords == null || baseline == null) return null;
  const sitting = todayWords - baseline;
  return (
    <span className="immersive-writing-control__words">
      <span className="immersive-writing-control__figure">
        {`${sitting < 0 ? '−' : '+'}${Math.abs(sitting).toLocaleString()}`}
      </span>
      {progress != null && (
        <span
          className="sand-stroke immersive-writing-control__goal"
          style={{ width: `${progress * 100}%` }}
        />
      )}
    </span>
  );
}
