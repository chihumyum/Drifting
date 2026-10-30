import { useState } from 'react';

import { revealDesktopAgentView } from '../../../store/desktop-agent-navigation';
import {
  useProjectCheckinStore,
  type StoredCheckinCard,
} from '../../../store/project-checkin-store';
import {
  openCheckinConversation,
  startCheckinCardSession,
  startProjectHomeConversation,
  useProjectCheckin,
} from '../../../usecase/useProjectCheckin';

export type HomeAgentModel = ReturnType<typeof useHomeAgent>;

/**
 * The Agent on Project Home: one conversation box about the whole book and
 * the check-in cards the Agent prepared from recent changes. The page shows
 * it whole in its flow; floating at the foot of the page it keeps only the
 * cards (one short pill each) above the box. Both share one draft.
 */
export function useHomeAgent(projectId: string, projectName: string) {
  const checkin = useProjectCheckin(projectId, projectName);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [busyCard, setBusyCard] = useState<string | null>(null);
  const [cardError, setCardError] = useState<{ id: string; message: string } | null>(null);

  const send = async () => {
    if (!draft.trim() || sending) return;
    setSending(true);
    try {
      await startProjectHomeConversation(projectId, draft, revealDesktopAgentView);
      setDraft('');
    } finally {
      setSending(false);
    }
  };

  const act = async (card: StoredCheckinCard) => {
    if (busyCard) return;
    setBusyCard(card.id);
    setCardError(null);
    try {
      if (card.status === 'started' && card.conversationId) {
        await openCheckinConversation(projectId, card.conversationId, revealDesktopAgentView);
      } else {
        await startCheckinCardSession(projectId, card, revealDesktopAgentView);
      }
    } catch (error) {
      setCardError({ id: card.id, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyCard(null);
    }
  };

  const dismiss = (cardId: string) => useProjectCheckinStore.getState().dismissCard(projectId, cardId);

  return { ...checkin, projectId, draft, setDraft, sending, send, busyCard, cardError, act, dismiss };
}
