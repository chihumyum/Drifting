import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, DownloadCloud, Loader2, UploadCloud, X } from 'lucide-react';
import { events, type SyncOperationEvent } from '../../lib/events';
import { useDataStore } from '../../store/data-store';
import { useProjectStore } from '../../store/project-store';

type SyncToast = SyncOperationEvent & {
  expiresAt: number | null;
};

const MAX_TOASTS = 4;
const SUCCESS_VISIBLE_MS = 9999;
const ERROR_VISIBLE_MS = 9999;

function getExpiry(event: SyncOperationEvent): number | null {
  if (event.state === 'started') return null;
  return Date.now() + (event.state === 'failed' ? ERROR_VISIBLE_MS : SUCCESS_VISIBLE_MS);
}

function formatDocId(docId?: string): string {
  if (!docId) return 'n/a';
  if (docId.startsWith('node-content:')) {
    return `node-content / ${docId.slice('node-content:'.length)}`;
  }
  return docId;
}

function getNodeIdFromDocId(docId: string): string | null {
  if (!docId.startsWith('node-content:')) return null;
  return docId.slice('node-content:'.length) || null;
}

function shortId(value?: string): string {
  if (!value) return 'n/a';
  if (value.length <= 12) return value;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function formatDuration(ms?: number): string {
  if (ms === undefined) return '...';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function getTitle(event: SyncToast): string {
  const action =
    event.kind === 'crud'
      ? `${event.operation[0].toUpperCase()}${event.operation.slice(1)}`
      : event.phase === 'push'
        ? 'Push'
        : 'Pull';
  if (event.state === 'started') return `${action} syncing`;
  if (event.state === 'failed') return `${action} failed`;
  return `${action} complete`;
}

function getTone(event: SyncToast) {
  if (event.state === 'failed') {
    return {
      border: 'rgba(185, 28, 28, 0.35)',
      background: '#fff7f7',
      color: '#991b1b',
      icon: <AlertTriangle size={16} />,
    };
  }

  if (event.state === 'started') {
    return {
      border: 'rgba(37, 99, 235, 0.3)',
      background: '#f8fbff',
      color: '#1d4ed8',
      icon: <Loader2 size={16} />,
    };
  }

  return {
    border: 'rgba(22, 101, 52, 0.28)',
    background: '#f7fff9',
    color: '#166534',
    icon: <CheckCircle2 size={16} />,
  };
}

function getUpdateSummary(event: SyncToast): string {
  if (event.kind === 'crud') {
    if (event.resourceCount !== undefined) return `${event.resourceCount} resources fetched`;
    return `${event.entityType ?? 'entity'} ${event.operation}`;
  }

  if (event.phase === 'push') {
    return `${event.localUpdateCount ?? 0} local updates, ${event.serverSeqCount ?? 0} accepted`;
  }

  return `${event.remoteUpdateCount ?? 0} remote, ${event.appliedUpdateCount ?? 0} applied, ${
    event.skippedUpdateCount ?? 0
  } own skipped`;
}

function getEntityTypeLabel(entityType?: string): string {
  switch (entityType) {
    case 'project':
      return 'Project';
    case 'node':
    case 'nodeContent':
      return 'Chapter';
    case 'nodeEdge':
      return 'Node edge';
    case 'storyline':
      return 'Storyline';
    case 'nodeStorylineLink':
      return 'Storyline link';
    case 'element':
      return 'Element';
    case 'elementCategory':
      return 'Element category';
    case 'elementStage':
      return 'Element stage';
    case 'elementTag':
      return 'Element tag';
    case 'elementTagLink':
      return 'Element tag link';
    case 'nodeTag':
      return 'Node tag';
    case 'nodeTagLink':
      return 'Node tag link';
    case 'storyStage':
      return 'Story stage';
    default:
      return 'Entity';
  }
}

function quoteEntityName(entityType: string | undefined, entityName: string, entityId?: string) {
  return `${getEntityTypeLabel(entityType)} "${entityName}" (${shortId(entityId)})`;
}

export function SyncStatusHUD() {
  const [toasts, setToasts] = useState<SyncToast[]>([]);
  const bookNodes = useDataStore((state) => state.bookNodes);
  const storylines = useDataStore((state) => state.storylines);
  const bookElements = useDataStore((state) => state.bookElements);
  const bookElementCategories = useDataStore((state) => state.bookElementCategories);
  const nodeTags = useDataStore((state) => state.nodeTags);
  const elementTags = useDataStore((state) => state.elementTags);
  const projects = useProjectStore((state) => state.projects);
  const currentProject = useProjectStore((state) => state.currentProject);

  const entityNameByKey = useMemo(() => {
    const map = new Map<string, string>();
    projects.forEach((project) => map.set(`project:${project.id}`, project.name));
    if (currentProject) map.set(`project:${currentProject.id}`, currentProject.name);
    bookNodes.forEach((node) => map.set(`node:${node.id}`, node.title));
    bookNodes.forEach((node) => map.set(`nodeContent:${node.id}`, node.title));
    storylines.forEach((storyline) => map.set(`storyline:${storyline.id}`, storyline.name));
    bookElements.forEach((element) => map.set(`element:${element.id}`, element.name));
    bookElementCategories.forEach((category) =>
      map.set(`elementCategory:${category.id}`, category.name),
    );
    nodeTags.forEach((tag) => map.set(`nodeTag:${tag.id}`, tag.name));
    elementTags.forEach((tag) => map.set(`elementTag:${tag.id}`, tag.name));
    return map;
  }, [
    bookElementCategories,
    bookElements,
    bookNodes,
    currentProject,
    elementTags,
    nodeTags,
    projects,
    storylines,
  ]);

  const formatEntityName = (toast: SyncToast): string => {
    if (toast.entityName?.trim()) {
      return quoteEntityName(toast.entityType, toast.entityName.trim(), toast.entityId);
    }

    let entityType = toast.entityType;
    let entityId = toast.entityId;
    if (!entityType && toast.docId) {
      entityType = 'nodeContent';
      entityId = getNodeIdFromDocId(toast.docId) ?? undefined;
    }

    const name =
      entityType && entityId ? entityNameByKey.get(`${entityType}:${entityId}`)?.trim() : undefined;
    if (name) return quoteEntityName(entityType, name, entityId);

    return `${getEntityTypeLabel(entityType)} ${shortId(entityId)}`;
  };

  useEffect(() => {
    const handleSyncOperation = (event: SyncOperationEvent) => {
      setToasts((current) => {
        const nextToast: SyncToast = { ...event, expiresAt: getExpiry(event) };
        const existingIndex = current.findIndex((item) => item.requestId === event.requestId);
        const next =
          existingIndex >= 0
            ? current.map((item, index) => (index === existingIndex ? nextToast : item))
            : [nextToast, ...current];

        return next
          .sort((a, b) => b.at - a.at)
          .slice(0, MAX_TOASTS);
      });
    };

    events.on('sync:operation', handleSyncOperation);
    const cleanupTimer = window.setInterval(() => {
      const now = Date.now();
      setToasts((current) =>
        current.filter((item) => item.expiresAt === null || item.expiresAt > now),
      );
    }, 500);

    return () => {
      events.off('sync:operation', handleSyncOperation);
      window.clearInterval(cleanupTimer);
    };
  }, []);

  const dismiss = (requestId: string) => {
    setToasts((current) => current.filter((item) => item.requestId !== requestId));
  };

  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed',
        right: 18,
        bottom: 72,
        width: 380,
        maxWidth: 'calc(100vw - 36px)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        zIndex: 1200,
        pointerEvents: 'none',
      }}
    >
      {toasts.map((toast) => {
        const tone = getTone(toast);
        const PhaseIcon = toast.phase === 'push' ? UploadCloud : DownloadCloud;

        return (
          <div
            key={toast.requestId}
            style={{
              pointerEvents: 'auto',
              border: `1px solid ${tone.border}`,
              background: tone.background,
              borderRadius: 8,
              boxShadow: '0 8px 28px rgba(15, 23, 42, 0.14)',
              padding: '10px 12px',
              color: '#172033',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 7,
              }}
            >
              <span style={{ display: 'flex', color: tone.color }}>{tone.icon}</span>
              <span style={{ display: 'flex', color: tone.color }}>
                <PhaseIcon size={16} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#172033' }}>
                  {getTitle(toast)}
                </div>
                <div style={{ fontSize: 11, color: '#64748b', marginTop: 1 }}>
                  {toast.kind.toUpperCase()} · {toast.method} {toast.endpoint} ·{' '}
                  {formatDuration(toast.durationMs)}
                </div>
              </div>
              <button
                type="button"
                aria-label="Dismiss sync status"
                onClick={() => dismiss(toast.requestId)}
                style={{
                  width: 24,
                  height: 24,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: 'none',
                  borderRadius: 6,
                  background: 'transparent',
                  color: '#64748b',
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              >
                <X size={14} />
              </button>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '58px 1fr',
                gap: '4px 8px',
                fontSize: 11,
                lineHeight: 1.35,
              }}
            >
              {toast.docId && (
                <>
                  <span style={{ color: '#64748b' }}>File</span>
                  <span
                    title={toast.docId}
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: '#334155',
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    }}
                  >
                    {formatDocId(toast.docId)}
                  </span>
                </>
              )}

              <span style={{ color: '#64748b' }}>Entity</span>
              <span
                title={formatEntityName(toast)}
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: '#334155',
                }}
              >
                {formatEntityName(toast)}
              </span>

              <span style={{ color: '#64748b' }}>
                {toast.kind === 'crud' ? 'Operation' : 'Updates'}
              </span>
              <span style={{ color: '#334155' }}>{getUpdateSummary(toast)}</span>

              <span style={{ color: '#64748b' }}>Device</span>
              <span
                title={toast.deviceId}
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: '#334155',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                }}
              >
                {shortId(toast.deviceId)}
              </span>

              {toast.error && (
                <>
                  <span style={{ color: '#64748b' }}>Error</span>
                  <span style={{ color: '#991b1b' }}>{toast.error}</span>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
