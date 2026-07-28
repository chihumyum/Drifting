import { useTranslation } from 'react-i18next';
import { useAgentConfirmStore } from '../../store/agent-confirm-store';
import { Button } from '../ui/Button';
import { ModalActions, ModalBody, ModalCard, ModalHeader, ModalRoot } from '../ui/Modal';

/**
 * Global, non-blocking confirmation dialog for the agent's destructive tools.
 * Mounted once at the app root; renders only while a request is pending. See
 * agent-confirm-store for the promise/timeout plumbing.
 */
export function AgentConfirmDialog() {
  const { t } = useTranslation();
  const pending = useAgentConfirmStore((s) => s.pending);
  if (!pending) return null;

  return (
    <ModalRoot onClose={() => pending.respond(false)} ariaLabel={t('common.confirm')}>
      <ModalCard width={440}>
        <ModalHeader title={t('common.confirm')} />
        <ModalBody>
        <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{pending.message}</div>
        </ModalBody>
        <ModalActions>
          <Button variant="default" onClick={() => pending.respond(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            autoFocus
            onClick={() => pending.respond(true)}
          >
            {t('agentConfirm.allowDelete')}
          </Button>
        </ModalActions>
      </ModalCard>
    </ModalRoot>
  );
}
