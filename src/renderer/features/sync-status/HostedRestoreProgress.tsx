import { useTranslation } from 'react-i18next';
import { useHostedRestoreStatus } from './hosted-restore-status';

/** The progress hairline; without a ratio it shows the phase is still working. */
export function HostedRestoreMeter({ ratio, label }: { ratio: number | null; label: string }) {
  const percent = ratio === null ? null : Math.round(Math.min(1, Math.max(0, ratio)) * 100);
  return (
    <span
      className="ui-progress hosted-restore__meter"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(percent === null ? {} : { 'aria-valuenow': percent })}
      data-indeterminate={percent === null ? 'true' : undefined}
    >
      <span className="ui-progress__fill" style={percent === null ? undefined : { width: `${percent}%` }} />
    </span>
  );
}

/** On the shelf while a connect restores this library's books. */
export function HostedRestoreBanner() {
  const { t } = useTranslation();
  const status = useHostedRestoreStatus();
  if (!status) return null;
  const title = t('settings.hosted.restore.title');
  return (
    <section className="hosted-restore" role="status" aria-live="polite">
      <p className="hosted-restore__title">{title}</p>
      <HostedRestoreMeter ratio={status.ratio} label={title} />
      <p className="hosted-restore__detail">{status.text}</p>
    </section>
  );
}
