import { useLayoutEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { motion, useIsPresent, useReducedMotion } from 'framer-motion';
import { createAgentConversationRepository } from '../../../sqlite-repo/agent-conversation-repo';
import { useAgentChatStore } from '../../../store/agent-chat-store';
import { MobileAgentPanel } from './MobileAgentPanel';
import { MOBILE_NATIVE_KEYBOARD_GEOMETRY_EVENT, readMobileKeyboardViewportOffsetTop } from './mobile-keyboard-geometry';
import { MobilePaperAgentSession } from './mobile-paper-agent-session';

export function MobilePaperAgent({ projectId, paperKey, keyboardInset, focusComposer, onClose }: {
  projectId: string;
  paperKey: string;
  keyboardInset: number;
  focusComposer: boolean;
  onClose: () => void;
}) {
  const isPresent = useIsPresent();
  const reducedMotion = useReducedMotion();
  const session = useMemo(() => new MobilePaperAgentSession(projectId, paperKey, useAgentChatStore,
    async (id, pid) => (await createAgentConversationRepository().listByProject(pid)).some((conversation) => conversation.id === id),
  ), [projectId, paperKey]);
  const binding = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [viewportTop, setViewportTop] = useState(readMobileKeyboardViewportOffsetTop);
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    const sync = () => setViewportTop(readMobileKeyboardViewportOffsetTop());
    viewport?.addEventListener('resize', sync);
    viewport?.addEventListener('scroll', sync);
    window.addEventListener(MOBILE_NATIVE_KEYBOARD_GEOMETRY_EVENT, sync);
    return () => {
      viewport?.removeEventListener('resize', sync);
      viewport?.removeEventListener('scroll', sync);
      window.removeEventListener(MOBILE_NATIVE_KEYBOARD_GEOMETRY_EVENT, sync);
    };
  }, []);
  useLayoutEffect(() => { if (!isPresent) return; void session.open(); return () => session.dispose(); }, [isPresent, session]);
  return (
    <motion.section className="m-paper-agent" data-debug-id="mobile-paper-agent" inert={!isPresent} data-keyboard={keyboardInset > 0 ? 'open' : 'closed'}
      style={{ '--m-unified-keyboard-inset': `${keyboardInset}px`, '--m-agent-viewport-top': `${viewportTop}px` } as CSSProperties}
      initial={{ y: reducedMotion ? 0 : 28, opacity: 0 }} animate={{ y: 0, opacity: 1 }}
      exit={{ y: reducedMotion ? 0 : 40, opacity: 0 }} transition={{ duration: reducedMotion ? 0 : 0.2 }}>
      <MobileAgentPanel projectId={projectId} target={null} paperBinding={binding} onClose={onClose} focusComposer={focusComposer} />
    </motion.section>
  );
}
