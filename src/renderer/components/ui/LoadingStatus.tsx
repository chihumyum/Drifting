import '../../../styles/loading-status.css';

/** A local waiting state. Its owner decides when data or a view is ready. */
export function LoadingStatus({ label }: { label: string }) {
  return (
    <div className="loading-status" role="status" aria-live="polite">
      <span className="loading-status__spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
