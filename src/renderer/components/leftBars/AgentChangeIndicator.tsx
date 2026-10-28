import type { ButtonHTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';
import { BrushIcon } from '../ui/BrushIcon';

/** Acknowledges only its scope; never opens, expands or drags the parent row. */
export function AgentChangeIndicator({
  onClick, className = '', title, disabled, children, style, ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  const { t } = useTranslation();
  if (disabled) return <span aria-hidden className={className} title={title} style={style}>{children}</span>;
  const label = `${title ? `${title} · ` : ''}${t('agentActivity.markSeen')}`;
  return (
    <button
      {...props}
      style={style}
      type="button"
      className={`agent-change-indicator ${className}`.trim()}
      title={label}
      aria-label={label}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.(event);
      }}
    >
      <span className="agent-change-indicator__label">{children}</span>
      <span aria-hidden className="agent-change-indicator__read">
        <BrushIcon name="check" size={10} />
      </span>
    </button>
  );
}
