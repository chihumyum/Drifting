import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { BrushIcon } from '../ui/BrushIcon';
import { GhostIconButton } from '../ui/GhostIconButton';
import { useTodayWords } from './useTodayWords';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { formatAccelerator } from '../../lib/shortcuts';
import { useShortcutsStore } from '../../store/shortcuts-store';
import { useUiStore } from '../../store/ui-store';
import { toggleImmersiveWriting } from './immersive-writing';

/**
 * Immersive writing's own round glass button, a stick of incense, right of
 * the paper's toolbar in the corner that carries the timeline toggle
 * (EditorTopBar), so it is the corner's last control. While immersed that
 * whole corner fades with the rest of the chrome.
 */
export function ImmersiveWritingControl() {
  const immersive = useUiStore((state) => state.immersiveWriting);
  return (
    <div className="immersive-writing-control">
      <ImmersiveWritingToggle immersive={immersive} />
    </div>
  );
}

/**
 * The way out while immersed: the same button, pressed, in the stage's own
 * lower-right corner — where the corner's incense stood — with this
 * sitting's words to its left; shown only while the pointer is near it
 * (immersive-writing.css).
 */
export function StageImmersiveWritingControl() {
  const immersive = useUiStore((state) => state.immersiveWriting);
  if (!immersive) return null;
  return (
    <div className="immersive-writing-control immersive-writing-control--stage">
      <SittingWords />
      <ImmersiveWritingToggle immersive />
    </div>
  );
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
      icon={<BrushIcon name="incense" />}
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
