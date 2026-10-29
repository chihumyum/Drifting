import { createContext, useContext } from 'react';

/**
 * Whether the transcript wears sand and glass (the desktop Agent panel). The
 * paused mobile shell renders the same message views without it and keeps its
 * own fallback look; see docs/design-system/components.md.
 */
export const AgentGlassContext = createContext(false);

export const useAgentGlass = () => useContext(AgentGlassContext);
