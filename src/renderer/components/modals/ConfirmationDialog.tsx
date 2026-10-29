import { useTranslation } from 'react-i18next';
import { useConfirmationStore } from '../../store/confirmation-store';
import { BrushIcon } from '../ui/BrushIcon';
import { Button } from '../ui/Button';
import { ModalActions, ModalBody, ModalCard, ModalHeader, ModalRoot } from '../ui/Modal';

/**
 * The single confirmation host for recovery, desktop, mobile, and Agent flows.
 * It renders only while the application-wide FIFO has an active request.
 * A destructive request opens with the focus on Cancel, so Enter never
 * deletes; any other opens on its confirming button.
 */
export function ConfirmationDialog() {
  const { t } = useTranslation();
  const pending = useConfirmationStore((state) => state.pending);
  if (!pending) return null;

  const title = pending.title ?? t('common.confirm');
  const confirmLabel =
    pending.confirmLabel ??
    (pending.source === 'agent' ? t('agentConfirm.allowDelete') : t('common.confirm'));
  const destructive = Boolean(pending.destructive);

  return (
    <ModalRoot onClose={() => pending.respond(false)} ariaLabel={title}>
      <ModalCard width={440}>
        <ModalHeader title={title} />
        <ModalBody>
          <div className="confirmation-dialog__message">{pending.message}</div>
        </ModalBody>
        <ModalActions>
          <Button variant="default" autoFocus={destructive} onClick={() => pending.respond(false)}>
            {pending.cancelLabel ?? t('common.cancel')}
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            autoFocus={!destructive}
            onClick={() => pending.respond(true)}
          >
            {destructive && <BrushIcon name="trash" size={14} />}
            {confirmLabel}
          </Button>
        </ModalActions>
      </ModalCard>
    </ModalRoot>
  );
}
