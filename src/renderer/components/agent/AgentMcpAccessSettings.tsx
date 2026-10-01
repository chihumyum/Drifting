import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { platform } from '../../platform';
import { getPlatformRuntime } from '../../platform/runtime';
import type { McpClient, McpServerConnection } from '../../platform/mcp-server-contract';
import { useProjectStore } from '../../store/project-store';
import { SettingsSectionHeader } from '../../features/settings/SettingsPrimitives';

export function AgentMcpAccessSettings({ open }: { open: boolean }) {
  const { t } = useTranslation();
  const project = useProjectStore((state) => state.currentProject);
  const [connections, setConnections] = useState<McpServerConnection[]>([]);
  const [name, setName] = useState('');
  const [permission, setPermission] = useState<'read' | 'write' | 'full'>('read');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const supported = getPlatformRuntime().isMacDesktop;
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
  const projectConnections = connections.filter(
    (connection) => connection.grant.projectId === project.id,
  );
  const connect = (client: McpClient, connection?: McpServerConnection) =>
    void run(async () => {
      await platform.mcpServer.connect(
        {
          name: client === 'codex' ? 'Codex' : 'Claude Code',
          projectId: project.id,
          access: connection?.grant.access ?? (permission === 'read' ? 'read' : 'write'),
          allowDangerous: connection?.grant.allowDangerous ?? permission === 'full',
        },
        client,
      );
      setMessage(
        t('settings.agent.mcpAccess.installed', {
          client: client === 'codex' ? 'Codex' : 'Claude Code',
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
  return (
    <div className="set-sec">
      <SettingsSectionHeader title={t('settings.agent.mcpAccess.title')} hint="MCP" />
      <p className="set-row__desc">
        {t('settings.agent.mcpAccess.desc', { project: project.name })}
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '12px 0' }}>
        <select
          className="set-input"
          aria-label={t('settings.agent.mcpAccess.newPermission')}
          disabled={busy}
          value={permission}
          onChange={(event) => setPermission(event.target.value as typeof permission)}
        >
          <option value="read">{t('settings.agent.mcpAccess.read')}</option>
          <option value="write">{t('settings.agent.mcpAccess.write')}</option>
          <option value="full">{t('settings.agent.mcpAccess.full')}</option>
        </select>
        {(['codex', 'claude_code'] as const).map((client) => {
          const existing = projectConnections.find(
            (connection) => connection.grant.installation?.client === client,
          );
          const label = client === 'codex' ? 'Codex' : 'Claude Code';
          return (
            <button
              key={client}
              className="set-btn set-btn--primary"
              disabled={busy || Boolean(existing)}
              onClick={() => connect(client)}
            >
              {t(
                existing
                  ? 'settings.agent.mcpAccess.connected'
                  : 'settings.agent.mcpAccess.connect',
                { client: label },
              )}
            </button>
          );
        })}
      </div>
      <p className="set-row__desc">{t('settings.agent.mcpAccess.newPermission')}</p>
      <p className="set-row__desc">{t('settings.agent.mcpAccess.automatic')}</p>
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
          <button
            className="set-btn"
            disabled={busy || !name.trim()}
            onClick={() =>
              void run(async () => {
                const connection = await platform.mcpServer.create({
                  name,
                  projectId: project.id,
                  access: permission === 'read' ? 'read' : 'write',
                  allowDangerous: permission === 'full',
                });
                setSelected(connection.grant.id);
                setName('');
              })
            }
          >
            {t('settings.agent.mcpAccess.create')}
          </button>
        </div>
      </details>
      <p className="set-row__desc" style={{ marginTop: 12 }}>
        {t('settings.agent.mcpAccess.local')}
      </p>
      {projectConnections.map((connection) => (
        <div key={connection.grant.id} style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: 1 }}>{connection.grant.name}</span>
            <select
              className="set-input"
              aria-label={t('settings.agent.mcpAccess.connectionPermission', { name: connection.grant.name })}
              disabled={busy}
              value={connection.grant.allowDangerous ? 'full' : connection.grant.access}
              onChange={(event) => {
                const value = event.target.value;
                void run(async () => {
                  const updated = await platform.mcpServer.updatePermission({
                    id: connection.grant.id,
                    access: value === 'read' ? 'read' : 'write',
                    allowDangerous: value === 'full',
                  });
                  setConnections((rows) => rows.map((row) => row.grant.id === updated.grant.id ? updated : row));
                  setMessage(t('settings.agent.mcpAccess.permissionUpdated'));
                });
              }}
            >
              <option value="read">{t('settings.agent.mcpAccess.read')}</option>
              <option value="write">{t('settings.agent.mcpAccess.write')}</option>
              <option value="full">{t('settings.agent.mcpAccess.full')}</option>
            </select>
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
      ))}
      {message && (
        <p role="status" className="set-row__desc" style={{ marginTop: 12 }}>
          {message}
        </p>
      )}
    </div>
  );
}
