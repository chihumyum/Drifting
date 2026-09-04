import { useTranslation } from 'react-i18next';
import { useConfirmationStore } from '../../store/confirmation-store';
import { Button } from '../ui/Button';
import { ModalActions, ModalBody, ModalCard, ModalHeader, ModalRoot } from '../ui/Modal';

/**
 * The single confirmation host for recovery, desktop, mobile, and Agent flows.
 * It renders only while the application-wide FIFO has an active request.
 */
export function ConfirmationDialog() {
  const { t } = useTranslation();
  const pending = useConfirmationStore((state) => state.pending);
  if (!pending) return null;

  const title = pending.title ?? t('common.confirm');
  const confirmLabel =
    pending.confirmLabel ??
    (pending.source === 'agent' ? t('agentConfirm.allowDelete') : t('common.confirm'));

  return (
    <ModalRoot onClose={() => pending.respond(false)} ariaLabel={title}>
      <ModalCard width={440}>
        <ModalHeader title={title} />
        <ModalBody>
          <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
            {pending.message}
          </div>
        </ModalBody>
        <ModalActions>
          <Button variant="default" onClick={() => pending.respond(false)}>
            {pending.cancelLabel ?? t('common.cancel')}
          </Button>
          <Button
            variant={pending.destructive ? 'danger' : 'primary'}
            autoFocus
            onClick={() => pending.respond(true)}
          >
            {confirmLabel}
          </Button>
        </ModalActions>
      </ModalCard>
    </ModalRoot>
  );
}
