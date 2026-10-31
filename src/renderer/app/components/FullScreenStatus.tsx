import { useCharSeaEnabled, useCharSeaHold } from '../../components/char-sea/useCharSea';

interface FullScreenStatusProps {
  title: string;
  detail?: string;
  loading?: boolean;
  action?: { label: string; onClick: () => void };
  secondaryAction?: { label: string; onClick: () => void };
}

export function FullScreenStatus({ title, detail, loading = false, action, secondaryAction }: FullScreenStatusProps) {
  // On the desktop a full-window wait is the sea of characters: drops fall
  // once it passes the loading delay. The words stay for screen readers. A
  // wait that fails comes back here with its retry and its way back.
  const sea = useCharSeaEnabled() && loading && !action;
  useCharSeaHold('loading', sea);
  if (sea) {
    return (
      <div role="status" aria-live="polite" className="app-fullscreen-status app-fullscreen-status--sea">
        <span className="sr-only">{detail ? `${title} ${detail}` : title}</span>
      </div>
    );
  }
  return (
    <div
      role={action ? 'alert' : 'status'}
      aria-live={action ? 'assertive' : 'polite'}
      className={`app-fullscreen-status${loading ? ' app-fullscreen-status--loading' : ''}`}
    >
      <div className="app-fullscreen-status__content">
        {loading && <span className="app-fullscreen-status__spinner" aria-hidden="true" />}
        <div className="app-fullscreen-status__title">{title}</div>
        {detail && <div className="app-fullscreen-status__detail">{detail}</div>}
        {action && (
          <button
            type="button"
            className="set-btn set-btn--primary app-fullscreen-status__action"
            onClick={action.onClick}
          >
            {action.label}
          </button>
        )}
        {secondaryAction && (
          <button
            type="button"
            className="set-btn app-fullscreen-status__action"
            onClick={secondaryAction.onClick}
          >
            {secondaryAction.label}
          </button>
        )}
      </div>
    </div>
  );
}
