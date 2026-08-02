import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { v7 as uuidv7 } from 'uuid';
import type { AgentChatMessage, AgentConvMode } from '../../domain/agent-conversation';
import type {
  AgentUserCheckpointPreview,
  AgentUserCheckpointSummary,
} from '../../domain/agent-user-checkpoint';
import { getAgentUserCheckpointService } from '../../services/agent-user-checkpoint.service';
import { AnchoredPopover } from '../ui/AnchoredPopover';

interface AgentCheckpointMenuProps {
  projectId: string;
  conversationId: string | null;
  runtimeSessionId: string | null;
  forkCheckpointId: string | null;
  messages: AgentChatMessage[];
  mode: AgentConvMode;
  disabled: boolean;
  loadConversation: (id: string) => Promise<void>;
  refreshConversations: () => void;
}

function relativeTime(iso: string): string {
  const date = new Date(iso);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { month: '2-digit', day: '2-digit' });
}

export function AgentCheckpointMenu(props: AgentCheckpointMenuProps) {
  const { t } = useTranslation();
  const service = getAgentUserCheckpointService();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<AgentUserCheckpointSummary[]>([]);
  const [preview, setPreview] = useState<AgentUserCheckpointPreview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!props.conversationId) {
      setRows([]);
      return;
    }
    try {
      setRows(await service.list(props.projectId, props.conversationId));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }, [props.conversationId, props.projectId, service]);

  useEffect(() => {
    const refreshTimer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(refreshTimer);
  }, [refresh, props.disabled]);

  const run = useCallback(
    async (key: string, work: () => Promise<void>) => {
      setBusy(key);
      setNotice(null);
      try {
        await work();
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const captureManual = () => {
    if (!props.conversationId) return;
    void run('capture', async () => {
      await service.capture({
        projectId: props.projectId,
        conversationId: props.conversationId!,
        runtimeSessionId: props.runtimeSessionId,
        sourceTurnId: null,
        label: t('agentPanel.checkpoints.manualLabel', {
          defaultValue: '手动检查点 {{time}}',
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        }),
        kind: 'manual',
        pinned: true,
        conversationMessages: [...props.messages],
        parentCheckpointId: props.forkCheckpointId,
      });
      await refresh();
      setNotice(t('agentPanel.checkpoints.saved', { defaultValue: '检查点已保存。' }));
    });
  };

  const fork = (checkpoint: AgentUserCheckpointSummary) => {
    void run(`fork:${checkpoint.id}`, async () => {
      const prepared = await service.preview({
        checkpointId: checkpoint.id,
        projectId: props.projectId,
        kind: 'conversation_fork',
        idempotencyKey: `ui:checkpoint-fork:${uuidv7()}`,
      });
      const result = await service.forkConversation({
        actionId: prepared.actionId,
        previewToken: prepared.previewToken,
        mode: props.mode,
      });
      props.refreshConversations();
      if (result.conversationId) await props.loadConversation(result.conversationId);
      setOpen(false);
    });
  };

  const prepareRestore = (checkpoint: AgentUserCheckpointSummary) => {
    void run(`preview:${checkpoint.id}`, async () => {
      const prepared = await service.preview({
        checkpointId: checkpoint.id,
        projectId: props.projectId,
        kind: 'restore_and_fork',
        idempotencyKey: `ui:checkpoint-restore:${uuidv7()}`,
      });
      setPreview(prepared);
    });
  };

  const confirmRestore = () => {
    if (!preview) return;
    void run(`restore:${preview.checkpointId}`, async () => {
      const result = await service.restore({
        actionId: preview.actionId,
        previewToken: preview.previewToken,
        overwriteConfirmed: preview.requiresExplicitOverwrite,
        mode: props.mode,
      });
      props.refreshConversations();
      if (result.conversationId) await props.loadConversation(result.conversationId);
      setPreview(null);
      setOpen(false);
    });
  };

  const togglePinned = (checkpoint: AgentUserCheckpointSummary) => {
    void run(`pin:${checkpoint.id}`, async () => {
      await service.setPinned(checkpoint.id, !checkpoint.pinned);
      await refresh();
    });
  };

  const remove = (checkpoint: AgentUserCheckpointSummary) => {
    void run(`remove:${checkpoint.id}`, async () => {
      await service.remove(checkpoint.id);
      if (preview?.checkpointId === checkpoint.id) setPreview(null);
      await refresh();
    });
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        style={triggerStyle}
        disabled={!props.conversationId}
        onClick={() => setOpen((value) => !value)}
        title={t('agentPanel.checkpoints.title', { defaultValue: '检查点与分叉' })}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        ◇ {rows.length > 0 ? rows.length : ''}
      </button>
      <AnchoredPopover
        anchorRef={triggerRef}
        open={open}
        onClose={() => {
          setOpen(false);
          setPreview(null);
        }}
        placement="bottom-end"
        role="dialog"
        ariaLabel={t('agentPanel.checkpoints.title', { defaultValue: '检查点与分叉' })}
        maxHeight={420}
        style={panelStyle}
        autoFocus={false}
        restoreFocus={false}
      >
        <div style={panelHeader}>
          <div>
            <div style={panelTitle}>
              {t('agentPanel.checkpoints.title', { defaultValue: '检查点与分叉' })}
            </div>
            <div style={panelHint}>
              {t('agentPanel.checkpoints.hint', {
                defaultValue: '分叉不改正文；恢复必须先预览，并会保留原对话。',
              })}
            </div>
          </div>
          <button
            type="button"
            style={primaryAction}
            disabled={props.disabled || busy !== null}
            onClick={captureManual}
          >
            {busy === 'capture'
              ? t('agentPanel.checkpoints.saving', { defaultValue: '保存中…' })
              : t('agentPanel.checkpoints.save', { defaultValue: '保存当前' })}
          </button>
        </div>
        {notice && <div style={noticeStyle}>{notice}</div>}
        {preview && (
          <div style={previewStyle}>
            <div style={previewTitle}>
              {preview.entities.some((entity) => entity.missing)
                ? t('agentPanel.checkpoints.previewMissing', {
                    defaultValue: '无法恢复：检查点中的实体已被删除',
                  })
                : t('agentPanel.checkpoints.previewSummary', {
                    defaultValue: '将恢复 {{changed}} 个有变化的实体',
                    changed: preview.changedEntityCount,
                  })}
            </div>
            <div style={panelHint}>
              {t('agentPanel.checkpoints.previewGuard', {
                defaultValue:
                  '执行前会再次校验所有 revision/hash；预览后出现的新编辑不会被覆盖。',
              })}
            </div>
            <div style={previewEntities}>
              {preview.entities
                .filter((entity) => entity.changed)
                .slice(0, 8)
                .map((entity) => (
                  <span key={`${entity.entityKind}:${entity.entityId}`} style={entityChip}>
                    {entity.displayName}
                    {entity.missing ? ' · 已删除' : ''}
                  </span>
                ))}
              {preview.changedEntityCount > 8 && (
                <span style={entityChip}>+{preview.changedEntityCount - 8}</span>
              )}
            </div>
            <div style={previewActions}>
              <button type="button" style={quietAction} onClick={() => setPreview(null)}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                style={dangerAction}
                disabled={
                  props.disabled ||
                  busy !== null ||
                  preview.entities.some((entity) => entity.missing)
                }
                onClick={confirmRestore}
              >
                {busy === `restore:${preview.checkpointId}`
                  ? t('agentPanel.checkpoints.restoring', { defaultValue: '恢复中…' })
                  : t('agentPanel.checkpoints.restoreAndFork', {
                      defaultValue: '确认恢复并分叉',
                    })}
              </button>
            </div>
          </div>
        )}
        <div style={listStyle}>
          {rows.length === 0 ? (
            <div style={emptyStyle}>
              {t('agentPanel.checkpoints.empty', {
                defaultValue: '发送任务前会自动保存；也可以现在手动保存。',
              })}
            </div>
          ) : (
            rows.map((checkpoint) => (
              <div key={checkpoint.id} style={rowStyle}>
                <div style={rowMain}>
                  <div style={rowTitle} title={checkpoint.label}>
                    {checkpoint.label || t('agentPanel.checkpoints.untitled', { defaultValue: '检查点' })}
                  </div>
                  <div style={rowMeta}>
                    {relativeTime(checkpoint.createdAt)} · {checkpoint.entityCount}{' '}
                    {t('agentPanel.checkpoints.entities', { defaultValue: '个正文实体' })}
                    {checkpoint.kind === 'manual' ? ' · 手动' : ''}
                  </div>
                </div>
                <button
                  type="button"
                  style={iconAction}
                  disabled={busy !== null}
                  title={checkpoint.pinned ? '取消固定' : '固定保留'}
                  onClick={() => togglePinned(checkpoint)}
                >
                  {checkpoint.pinned ? '◆' : '◇'}
                </button>
                <button
                  type="button"
                  style={quietAction}
                  disabled={props.disabled || busy !== null}
                  onClick={() => fork(checkpoint)}
                >
                  {t('agentPanel.checkpoints.fork', { defaultValue: '分叉' })}
                </button>
                <button
                  type="button"
                  style={quietAction}
                  disabled={props.disabled || busy !== null}
                  onClick={() => prepareRestore(checkpoint)}
                >
                  {t('agentPanel.checkpoints.preview', { defaultValue: '预览恢复' })}
                </button>
                <button
                  type="button"
                  style={iconAction}
                  disabled={busy !== null}
                  title={t('common.delete', { defaultValue: '删除' })}
                  onClick={() => remove(checkpoint)}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
      </AnchoredPopover>
    </>
  );
}

const triggerStyle: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'hsl(var(--ink-2))',
  fontSize: 12,
  padding: '3px 5px',
  borderRadius: 5,
  cursor: 'pointer',
};
const panelStyle: React.CSSProperties = { width: 410, padding: 0 };
const panelHeader: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  padding: '12px 12px 10px',
  borderBottom: '1px solid hsl(var(--line) / 0.7)',
};
const panelTitle: React.CSSProperties = { fontSize: 13, fontWeight: 650 };
const panelHint: React.CSSProperties = {
  color: 'hsl(var(--ink-3))',
  fontSize: 11.5,
  lineHeight: 1.45,
  marginTop: 3,
};
const primaryAction: React.CSSProperties = {
  border: '1px solid hsl(var(--line))',
  borderRadius: 6,
  background: 'hsl(var(--paper-2))',
  padding: '5px 8px',
  fontSize: 11.5,
  whiteSpace: 'nowrap',
};
const noticeStyle: React.CSSProperties = {
  padding: '8px 12px',
  fontSize: 11.5,
  color: 'hsl(var(--ink-2))',
  background: 'hsl(var(--paper-2))',
};
const previewStyle: React.CSSProperties = {
  margin: 10,
  padding: 10,
  borderRadius: 8,
  background: 'hsl(var(--danger) / 0.07)',
};
const previewTitle: React.CSSProperties = { fontSize: 12.5, fontWeight: 650 };
const previewEntities: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 5,
  marginTop: 8,
};
const entityChip: React.CSSProperties = {
  padding: '2px 6px',
  borderRadius: 999,
  background: 'hsl(var(--paper))',
  fontSize: 11,
};
const previewActions: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 6,
  marginTop: 10,
};
const listStyle: React.CSSProperties = { padding: '4px 0' };
const emptyStyle: React.CSSProperties = { padding: 14, fontSize: 12, opacity: 0.58 };
const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  padding: '7px 9px 7px 12px',
};
const rowMain: React.CSSProperties = { minWidth: 0, flex: 1 };
const rowTitle: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 12,
};
const rowMeta: React.CSSProperties = { color: 'hsl(var(--ink-3))', fontSize: 10.5, marginTop: 2 };
const quietAction: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'hsl(var(--ink-2))',
  padding: '3px 5px',
  fontSize: 11.5,
  cursor: 'pointer',
};
const dangerAction: React.CSSProperties = {
  ...quietAction,
  color: 'hsl(var(--danger))',
  fontWeight: 600,
};
const iconAction: React.CSSProperties = {
  ...quietAction,
  width: 22,
  padding: 2,
};
