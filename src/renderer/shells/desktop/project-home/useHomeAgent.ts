import { useState } from 'react';

import { revealDesktopAgentView } from '../../../store/desktop-agent-navigation';
import {
  useProjectCheckinStore,
  type StoredCheckinCard,
} from '../../../store/project-checkin-store';
import { useProjectOrganizeStore } from '../../../store/project-organize-store';
import {
  openCheckinConversation,
  startCheckinCardSession,
  startProjectHomeConversation,
  useProjectCheckin,
} from '../../../usecase/useProjectCheckin';
import {
  dismissOrganizeOffer,
  startProjectOrganize,
  useOrganizeOffer,
} from '../../../usecase/useProjectOrganize';

/** `busyCard` while the organize card is starting its session. */
const ORGANIZE_OFFER_ID = 'organize-offer';

export type HomeAgentModel = ReturnType<typeof useHomeAgent>;

/**
 * The Agent on Project Home: one conversation box about the whole book, the
 * task cards — the organize card for what the author wrote since the last
 * organize, then the check-in's cards — and the latest organize run. Nothing
 * on a card runs until the author opens it. The page shows it whole in its
 * flow; floating at the foot of the page it keeps only the cards (one short
 * pill each) above the box. Both share one draft.
 */
export function useHomeAgent(projectId: string, projectName: string) {
  const checkin = useProjectCheckin(projectId, projectName);
  useOrganizeOffer(projectId);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [busyCard, setBusyCard] = useState<string | null>(null);
  const [cardError, setCardError] = useState<{ id: string; message: string } | null>(null);
  const organizeRun = useProjectOrganizeStore((state) => state.projects[projectId]?.run ?? null);
  const organize = organizeRun && !organizeRun.dismissed ? organizeRun : null;
  const organizeOffer = useProjectOrganizeStore((state) =>
    checkin.enabled && !state.active[projectId] ? (state.offers[projectId] ?? null) : null,
  );
  const [organizeError, setOrganizeError] = useState<string | null>(null);
  const [offerError, setOfferError] = useState<string | null>(null);

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

  const openOrganize = async () => {
    if (!organize || busyCard) return;
    setBusyCard(organize.id);
    setOrganizeError(null);
    try {
      await openCheckinConversation(projectId, organize.conversationId, revealDesktopAgentView);
    } catch (error) {
      setOrganizeError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyCard(null);
    }
  };

  const startOrganize = async () => {
    if (busyCard) return;
    setBusyCard(ORGANIZE_OFFER_ID);
    setOfferError(null);
    try {
      await startProjectOrganize(projectId);
    } catch (error) {
      setOfferError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyCard(null);
    }
  };

  const dismissOrganize = () => {
    if (organize) useProjectOrganizeStore.getState().dismissRun(projectId, organize.id);
  };

  return {
    ...checkin,
    projectId,
    draft,
    setDraft,
    sending,
    send,
    busyCard,
    cardError,
    act,
    dismiss,
    organize,
    organizeError,
    openOrganize,
    dismissOrganize,
    organizeOffer,
    offerError,
    startOrganize,
    dismissOrganizeOffer: () => dismissOrganizeOffer(projectId),
  };
}
