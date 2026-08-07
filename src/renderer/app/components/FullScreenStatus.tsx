interface FullScreenStatusProps {
  title: string;
  detail?: string;
  action?: { label: string; onClick: () => void };
}

export function FullScreenStatus({ title, detail, action }: FullScreenStatusProps) {
  return (
    <div
      role={action ? 'alert' : 'status'}
      aria-live={action ? 'assertive' : 'polite'}
      className="app-fullscreen-status"
    >
      <div className="app-fullscreen-status__content">
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
      </div>
    </div>
  );
}
