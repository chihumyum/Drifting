import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { platform } from '../../platform';
import { getPlatformRuntime } from '../../platform/runtime';
import type { McpClient, McpServerConnection } from '../../platform/mcp-server-contract';
import { useProjectStore } from '../../store/project-store';
import { BrushIcon } from '../ui/BrushIcon';
import {
  SettingsButton,
  SettingsConfigField,
  SettingsField,
  SettingsSectionHeader,
  SettingsSelect,
} from '../../features/settings/SettingsPrimitives';
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
  const [manualOpen, setManualOpen] = useState(false);
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
  // Three short grants: one choice out of three, like every other few-option setting.
  const permissionSelect = (label: string, permission: McpAccessPermission, onChange: (value: McpAccessPermission) => void) => (
    <SettingsSelect<McpAccessPermission>
      few
      ariaLabel={label}
      disabled={busy}
      value={permission}
      onChange={onChange}
      options={[
        { value: 'read', label: t('settings.agent.mcpAccess.read') },
        { value: 'write', label: t('settings.agent.mcpAccess.write') },
        { value: 'full', label: t('settings.agent.mcpAccess.full') },
      ]}
    />
  );
  const renderConnection = (connection: McpServerConnection) => (
    <div key={connection.grant.id} className="set-mcp-access__item">
      <div className="set-mcp-access__row">
        <span className="set-mcp-access__name">{connection.grant.name}</span>
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
          <SettingsButton
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => connect(connection.grant.installation!.client, connection)}
          >
            {t('settings.agent.mcpAccess.reinstall')}
          </SettingsButton>
        )}
        <SettingsButton
          variant="ghost"
          size="sm"
          aria-expanded={selected === connection.grant.id}
          onClick={() => setSelected(selected === connection.grant.id ? null : connection.grant.id)}
        >
          {t('settings.agent.mcpAccess.config')}
        </SettingsButton>
        <SettingsButton
          variant="danger"
          size="sm"
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
        </SettingsButton>
      </div>
      {selected === connection.grant.id && (
        <div className="set-mcp-access__config">
          <SettingsConfigField
            readOnly
            rows={9}
            aria-label={t('settings.agent.mcpAccess.config')}
            value={config(connection)}
          />
          <SettingsButton
            size="sm"
            onClick={() =>
              void navigator.clipboard
                .writeText(config(connection))
                .then(() => setMessage(t('settings.agent.mcpAccess.copied')))
                .catch((error) => setMessage(String(error)))
            }
          >
            {t('settings.agent.mcpAccess.copy')}
          </SettingsButton>
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
      <p className="set-row__desc set-mcp-access__note">
        {t('settings.agent.mcpAccess.projectionDescription')}
      </p>
      {rows.clients.map(({ client, name: clientName, connection }) => connection
        ? renderConnection(connection)
        : (
          <div key={client} className="set-mcp-access__item set-mcp-access__row">
            <span className="set-mcp-access__name">{clientName}</span>
            {permissionSelect(
              t('settings.agent.mcpAccess.connectionPermission', { name: clientName }),
              draftPermission(client),
              permission => setDraftPermission(client, permission),
            )}
            <SettingsButton
              variant="primary"
              size="sm"
              disabled={busy}
              aria-label={t('settings.agent.mcpAccess.connect', { client: clientName })}
              onClick={() => connect(client)}
            >
              {t('settings.agent.mcpAccess.connectAction')}
            </SettingsButton>
          </div>
        ))}
      <p className="set-row__desc set-mcp-access__note">{t('settings.agent.mcpAccess.automatic')}</p>
      <div className="set-mcp-access__note">
        <SettingsButton
          variant="ghost"
          size="sm"
          className="set-disclosure"
          aria-expanded={manualOpen}
          onClick={() => setManualOpen((was) => !was)}
        >
          <BrushIcon name={manualOpen ? 'chevron-down' : 'chevron-right'} size={11} />
          {t('settings.agent.mcpAccess.manual')}
        </SettingsButton>
      </div>
      {manualOpen && (
        <>
          <div className="set-mcp-access__row set-mcp-access__manual">
            <SettingsField
              small
              aria-label={t('settings.agent.mcpAccess.name')}
              placeholder={t('settings.agent.mcpAccess.name')}
              maxLength={60}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            {permissionSelect(t('settings.agent.mcpAccess.permission'), draftPermission('manual'),
              permission => setDraftPermission('manual', permission))}
            <SettingsButton
              size="sm"
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
            </SettingsButton>
          </div>
          {rows.manual.map(renderConnection)}
        </>
      )}
      <p className="set-row__desc set-mcp-access__note">{t('settings.agent.mcpAccess.local')}</p>
      {message && (
        <p role="status" className="set-row__desc set-mcp-access__note">
          {message}
        </p>
      )}
    </div>
  );
}
