import { useTranslation } from 'react-i18next';
import type { AgentConversationContextRef } from '../../../domain/agent-conversation';
import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import { useWorkspaceNavigator } from '../../../features/workspace/navigation/WorkspaceNavigationContext';
import { scrollToBlockWhenReady } from '../../../lib/scroll-to-block';

export function ContextChips({ refs }: { refs: readonly AgentConversationContextRef[] }) {
  const { t } = useTranslation();
  const { open } = useWorkspaceNavigator();
  return (
    <div className="m-agent-context-chips" aria-label={t('agentPanel.mobile.contextAria')}>
      {refs.map((ref) => {
        const key = `${ref.kind}:${ref.entityType ?? ''}:${ref.entityId ?? ''}:${ref.blockId ?? ''}`;
        if (ref.kind === 'project' || !ref.entityType || !ref.entityId) {
          return <span key={key}>{t('agentPanel.mobile.contextProject')} · {ref.label}</span>;
        }
        const entityType = ref.entityType;
        const entityId = ref.entityId;
        const handleOpen = () => {
          const target: WorkspaceTarget =
            entityType === 'all-chapters'
              ? { entityType: 'all-chapters', id: 'self' }
              : { entityType, id: entityId };
          open(target);
          if (ref.blockId) scrollToBlockWhenReady(entityId, ref.blockId);
        };
        return (
          <button key={key} type="button" onClick={handleOpen}>
            {ref.blockId ? t('agentPanel.mobile.contextParagraph') : t('agentPanel.mobile.contextCurrent')} · {ref.label}
          </button>
        );
      })}
    </div>
  );
}
