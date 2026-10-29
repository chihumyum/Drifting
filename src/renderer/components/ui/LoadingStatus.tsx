import '../../../styles/loading-status.css';
import { BrushIcon } from './BrushIcon';

/** A local waiting state. Its owner decides when data or a view is ready.
 * On the desktop it is the brush loader (an ensō with a gap) turning in the
 * secondary ink, and it only shows once the wait passes 240ms, so a quick
 * read never flashes it. */
export function LoadingStatus({ label }: { label: string }) {
  return (
    <div className="loading-status" role="status" aria-live="polite">
      <span className="loading-status__spinner" aria-hidden="true">
        <BrushIcon name="loader" size={20} className="loading-status__brush" />
      </span>
      <span>{label}</span>
    </div>
  );
}
