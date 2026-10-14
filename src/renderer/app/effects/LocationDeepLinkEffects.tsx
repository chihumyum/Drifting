import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

import { usePendingLocationLinkStore } from '../../features/workspace/navigation/pending-location-link';
import { parseLocationHref } from '../../lib/location-link';
import { platform } from '../../platform';
import { getPlatformRuntime } from '../../platform/runtime';
import { useProjectStore } from '../../store/project-store';

/**
 * Route `drifting://open/<projectId>/<group>/<entity>/prose.md#L12` from the
 * operating system to that project; its workspace opens the passage.
 */
export function LocationDeepLinkEffects() {
  const navigate = useNavigate();
  useEffect(() => {
    if (getPlatformRuntime().target !== 'desktop') return undefined;
    return platform.locationLinks.onOpen((url) => {
      const projectId = parseLocationHref(url)?.projectId;
      if (!projectId) return;
      usePendingLocationLinkStore.getState().request(projectId, url);
      if (useProjectStore.getState().currentProject?.id !== projectId) {
        navigate(`/project/${encodeURIComponent(projectId)}`);
      }
    });
  }, [navigate]);
  return null;
}
