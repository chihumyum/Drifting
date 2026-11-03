import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BrushIcon } from '../ui/BrushIcon';
import { GhostIconButton } from '../ui/GhostIconButton';
import { useTodayWords } from './useTodayWords';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { formatAccelerator } from '../../lib/shortcuts';
import { useShortcutsStore } from '../../store/shortcuts-store';
import { useUiStore } from '../../store/ui-store';
import { enterImmersiveWriting, leaveImmersiveWriting, toggleImmersiveWriting } from './immersive-writing';

/**
 * The paper's toolbar button into immersive writing (the tea bowl). While
 * immersed the toolbar is gone, and the same button, pressed, waits in the
 * stage's corner instead.
 */
export function ImmersiveWritingToggle() {
  const { t } = useTranslation();
  const immersive = useUiStore((state) => state.immersiveWriting);
  const accelerator = useShortcutsStore((state) => state.bindings.toggleImmersiveWriting);
  const label = t(immersive ? 'immersiveWriting.leave' : 'immersiveWriting.enter');
  return (
    <button
      type="button"
      className="editor-bar__icon glass glass--round editor-bar__icon--immersive"
      title={`${label} · ${formatAccelerator(accelerator)}`}
      aria-label={label}
      aria-pressed={immersive}
      onClick={immersive ? leaveImmersiveWriting : enterImmersiveWriting}
    >
      <BrushIcon name="tea" />
    </button>
  );
}

/**
 * The stage's lower-right corner while immersed, shown only while the pointer
 * is there: this sitting's words over today's sand stroke toward the daily
 * goal, then the way out.
 */
export function ImmersiveWritingCorner() {
  const immersive = useUiStore((state) => state.immersiveWriting);
  return immersive ? <ImmersiveWritingCornerContent /> : null;
}

function ImmersiveWritingCornerContent() {
  const { t } = useTranslation();
  const { projectId } = useProjectNavigation();
  const { todayWords, progress } = useTodayWords(projectId);
  const accelerator = useShortcutsStore((state) => state.bindings.toggleImmersiveWriting);
  // Mounted when immersion begins: the words already written today by then
  // are not this sitting's.
  const [startedAt, setStartedAt] = useState(todayWords);
  if (startedAt == null && todayWords != null) setStartedAt(todayWords);
  const sitting = todayWords == null || startedAt == null ? null : todayWords - startedAt;
  const label = t('immersiveWriting.leave');
  return (
    <div className="immersive-writing-corner">
      {sitting != null && (
        <span className="immersive-writing-corner__words">
          <span className="immersive-writing-corner__figure">
            {`${sitting < 0 ? '−' : '+'}${Math.abs(sitting).toLocaleString()}`}
          </span>
          {progress != null && (
            <span
              className="sand-stroke immersive-writing-corner__goal"
              style={{ width: `${progress * 100}%` }}
            />
          )}
        </span>
      )}
      <GhostIconButton
        glass="round"
        className="immersive-writing-corner__leave glass--rest"
        aria-pressed
        aria-label={label}
        title={`${label} · ${formatAccelerator(accelerator)}`}
        onClick={toggleImmersiveWriting}
        icon={<BrushIcon name="tea" />}
      />
    </div>
  );
}
