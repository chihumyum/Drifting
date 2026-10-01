import { getMarkdownProjectionStatus, subscribeMarkdownProjectionStatus } from '../../services/markdown-projection-status';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { platform } from '../../platform';
import { getPlatformRuntime } from '../../platform/runtime';
import type { McpClient, McpServerConnection } from '../../platform/mcp-server-contract';
import { useProjectStore } from '../../store/project-store';
import { SettingsSectionHeader } from '../../features/settings/SettingsPrimitives';
import {
  mcpAccessGrant,
  mcpAccessPermission,
  mcpAccessRows,
  mcpClientNames,
  type McpAccessPermission,
} from './AgentMcpAccessState';

export function AgentMcpAccessSettings({ open }: { open: boolean }) {
  const { t } = useTranslation();
  const project = useProjectStore((state) => state.currentProject);
  const [connections, setConnections] = useState<McpServerConnection[]>([]);
  const [name, setName] = useState('');
  const [draftPermissions, setDraftPermissions] = useState<Record<string, McpAccessPermission>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const supported = getPlatformRuntime().isMacDesktop;
  const projection = useSyncExternalStore(subscribeMarkdownProjectionStatus,
    () => project ? getMarkdownProjectionStatus(project.id) : undefined);
  const reload = useCallback(async () => setConnections(await platform.mcpServer.list()), []);
  useEffect(() => {
    if (!open || !supported) return;
    let active = true;
    void platform.mcpServer
      .list()
      .then((rows) => {
        if (active) setConnections(rows);
      })
      .catch((error) => {
        if (active) setMessage(String(error));
      });
    return () => {
      active = false;
    };
  }, [open, supported]);
  if (!supported || !project) return null;
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      await action();
      await reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const rows = mcpAccessRows(connections, project.id);
  const draftPermission = (client: McpClient | 'manual') => draftPermissions[`${project.id}:${client}`] ?? 'read';
  const setDraftPermission = (client: McpClient | 'manual', permission: McpAccessPermission) =>
    setDraftPermissions(previous => ({ ...previous, [`${project.id}:${client}`]: permission }));
  const connect = (client: McpClient, connection?: McpServerConnection) =>
    void run(async () => {
      await platform.mcpServer.connect(
        {
          name: mcpClientNames[client],
          projectId: project.id,
          ...mcpAccessGrant(connection ? mcpAccessPermission(connection) : draftPermission(client)),
        },
        client,
      );
      setMessage(
        t('settings.agent.mcpAccess.installed', {
          client: mcpClientNames[client],
        }),
      );
    });
  const config = (connection: McpServerConnection) =>
    JSON.stringify(
      {
        mcpServers: {
          drifting: connection.config,
        },
      },
      null,
      2,
    );
  const permissionSelect = (label: string, permission: McpAccessPermission, onChange: (value: McpAccessPermission) => void) => (
    <select
      className="set-input"
      aria-label={label}
      disabled={busy}
      value={permission}
      onChange={(event) => onChange(event.target.value as McpAccessPermission)}
    >
      <option value="read">{t('settings.agent.mcpAccess.read')}</option>
      <option value="write">{t('settings.agent.mcpAccess.write')}</option>
      <option value="full">{t('settings.agent.mcpAccess.full')}</option>
    </select>
  );
  const renderConnection = (connection: McpServerConnection) => (
    <div key={connection.grant.id} style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 1 }}>{connection.grant.name}</span>
        {permissionSelect(
          t('settings.agent.mcpAccess.connectionPermission', { name: connection.grant.name }),
          mcpAccessPermission(connection),
          (value) => {
            void run(async () => {
              const updated = await platform.mcpServer.updatePermission({
                id: connection.grant.id,
                ...mcpAccessGrant(value),
              });
              setConnections((rows) => rows.map((row) => row.grant.id === updated.grant.id ? updated : row));
              setMessage(t('settings.agent.mcpAccess.permissionUpdated'));
            });
          },
        )}
        {connection.grant.installation && (
          <button
            className="set-btn"
            disabled={busy}
            onClick={() => connect(connection.grant.installation!.client, connection)}
          >
            {t('settings.agent.mcpAccess.reinstall')}
          </button>
        )}
        <button
          className="set-btn"
          onClick={() =>
            setSelected(selected === connection.grant.id ? null : connection.grant.id)
          }
        >
          {t('settings.agent.mcpAccess.config')}
        </button>
        <button
          className="set-btn"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const warning = await platform.mcpServer.revoke(connection.grant.id);
              setMessage(
                t(
                  warning
                    ? 'settings.agent.mcpAccess.revokedWarning'
                    : 'settings.agent.mcpAccess.revoked',
                ),
              );
              if (selected === connection.grant.id) setSelected(null);
              if (connection.grant.installation) setDraftPermission(connection.grant.installation.client, 'read');
            })
          }
        >
          {t('settings.agent.mcpAccess.revoke')}
        </button>
      </div>
      {selected === connection.grant.id && (
        <div style={{ marginTop: 8 }}>
          <textarea
            className="set-input"
            readOnly
            rows={9}
            style={{ width: '100%', fontFamily: 'monospace', fontSize: 11 }}
            aria-label={t('settings.agent.mcpAccess.config')}
            value={config(connection)}
          />
          <button
            className="set-btn"
            onClick={() =>
              void navigator.clipboard
                .writeText(config(connection))
                .then(() => setMessage(t('settings.agent.mcpAccess.copied')))
                .catch((error) => setMessage(String(error)))
            }
          >
            {t('settings.agent.mcpAccess.copy')}
          </button>
        </div>
      )}
    </div>
  );
  return (
    <div className="set-sec">
      <SettingsSectionHeader title={t('settings.agent.mcpAccess.title')} hint="MCP" />
      <p className="set-row__desc">
        {t('settings.agent.mcpAccess.desc', { project: project.name })}
      </p>
      <p className="set-row__desc" style={{ marginTop: 12 }}>
        {t('settings.agent.mcpAccess.projectionDescription')}
      </p>
      {projection && <div style={{ marginTop: 8 }}>
        <p role="status" className="set-row__desc">
          {t(`settings.agent.mcpAccess.projection${projection.state === 'ready' ? 'Ready' : projection.state === 'error' ? 'Error' : 'Pending'}`)}
          {projection.generatedAt ? ` · ${new Date(projection.generatedAt).toLocaleString()}` : ''}
          {projection.error ? ` · ${projection.error}` : ''}
        </p>
        {projection.directory && <code style={{ display: 'block', overflowWrap: 'anywhere', fontSize: 11, marginTop: 6 }}>{projection.directory}</code>}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button className="set-btn" disabled={!projection.directory} onClick={() => void run(async () => {
            await navigator.clipboard.writeText(projection.directory!);
            setMessage(t('settings.agent.mcpAccess.copied'));
          })}>{t('settings.agent.mcpAccess.projectionCopy')}</button>
          <button className="set-btn" disabled={busy} onClick={() => void run(async () => {
            const { refreshMarkdownProjection } = await import('../../services/markdown-projection.service');
            await refreshMarkdownProjection(project.id);
          })}>{t('settings.agent.mcpAccess.projectionRefresh')}</button>
        </div>
      </div>}
      {rows.clients.map(({ client, name: clientName, connection }) => connection
        ? renderConnection(connection)
        : (
          <div key={client} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 14 }}>
            <span style={{ flex: 1 }}>{clientName}</span>
            {permissionSelect(
              t('settings.agent.mcpAccess.connectionPermission', { name: clientName }),
              draftPermission(client),
              permission => setDraftPermission(client, permission),
            )}
            <button
              type="button"
              className="set-btn set-btn--primary"
              disabled={busy}
              aria-label={t('settings.agent.mcpAccess.connect', { client: clientName })}
              onClick={() => connect(client)}
            >
              {t('settings.agent.mcpAccess.connectAction')}
            </button>
          </div>
        ))}
      <p className="set-row__desc" style={{ marginTop: 12 }}>{t('settings.agent.mcpAccess.automatic')}</p>
      <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: 'pointer' }}>{t('settings.agent.mcpAccess.manual')}</summary>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '12px 0' }}>
          <input
            className="set-input"
            aria-label={t('settings.agent.mcpAccess.name')}
            placeholder={t('settings.agent.mcpAccess.name')}
            maxLength={60}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          {permissionSelect(t('settings.agent.mcpAccess.permission'), draftPermission('manual'),
            permission => setDraftPermission('manual', permission))}
          <button
            type="button"
            className="set-btn"
            disabled={busy || !name.trim()}
            onClick={() => void run(async () => {
              const connection = await platform.mcpServer.create({
                name: name.trim(),
                projectId: project.id,
                ...mcpAccessGrant(draftPermission('manual')),
              });
              setSelected(connection.grant.id);
              setName('');
              setDraftPermission('manual', 'read');
            })}
          >
            {t('settings.agent.mcpAccess.create')}
          </button>
        </div>
        {rows.manual.map(renderConnection)}
      </details>
      <p className="set-row__desc" style={{ marginTop: 12 }}>{t('settings.agent.mcpAccess.local')}</p>
      {message && (
        <p role="status" className="set-row__desc" style={{ marginTop: 12 }}>
          {message}
        </p>
      )}
    </div>
  );
}
