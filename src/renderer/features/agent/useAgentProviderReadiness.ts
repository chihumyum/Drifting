import { useEffect, useState } from 'react';
import {
  readAgentProviderReadiness,
  type AgentProviderReadiness,
} from '../../lib/agent/agent-provider-readiness';
import { AGENT_PROVIDER_OPTIONS } from '../../lib/agent/runtime/agent-provider-contract';
import { events } from '../../lib/events';

const PROVIDERS = AGENT_PROVIDER_OPTIONS.map((provider) => provider.value);

/**
 * Which providers have a usable credential (a key, or the ChatGPT sign-in)
 * while the model menu is open, read without decrypting anything. It is read
 * again when a key or sign-in changes and when the window regains focus.
 */
export function useAgentProviderReadiness(modelMenuOpen: boolean): AgentProviderReadiness {
  const [readiness, setReadiness] = useState<AgentProviderReadiness>({});
  useEffect(() => {
    if (!modelMenuOpen) return;
    let active = true;
    let latest = 0;
    const refresh = () => {
      const request = ++latest;
      void readAgentProviderReadiness(PROVIDERS).then((next) => {
        if (active && request === latest) setReadiness(next);
      });
    };
    refresh();
    events.on('byok:keys-changed', refresh);
    events.on('agent:auth-changed', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      active = false;
      events.off('byok:keys-changed', refresh);
      events.off('agent:auth-changed', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [modelMenuOpen]);
  return readiness;
}
