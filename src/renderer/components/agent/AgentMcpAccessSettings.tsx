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
} from '../../features/settings/SettingsPrimitives';
import { mcpAccessRows, mcpClientNames } from './AgentMcpAccessState';

/** `heading` is off where the settings panel around it already names it. */
export function AgentMcpAccessSettings({ open, heading = true }: { open: boolean; heading?: boolean }) {
  const { t } = useTranslation();
  const projects = useProjectStore((state) => state.projects);
  const [connections, setConnections] = useState<McpServerConnection[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const runtime = getPlatformRuntime();
  // The local bridge: a Unix socket on macOS, loopback TCP on Windows (mcp_server.rs).
  const supported = runtime.isMacDesktop || runtime.isWindowsDesktop;
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
  if (!supported) return null;
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
  const rows = mcpAccessRows(connections);
  const connect = (client: McpClient) =>
    void run(async () => {
      const connected = await platform.mcpServer.connect({ name: mcpClientNames[client] }, client);
      setMessage(
        t(connected.leftover ? 'settings.agent.mcpAccess.installedLeftover' : 'settings.agent.mcpAccess.installed', {
          client: mcpClientNames[client],
        }),
      );
    });
  // A connection an earlier version made for one book names that book.
  const connectionName = ({ grant }: McpServerConnection) => {
    const book = grant.projectId && projects.find(candidate => candidate.id === grant.projectId)?.name;
    return book ? `${grant.name} · ${book}` : grant.name;
  };
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
  const renderConnection = (connection: McpServerConnection) => (
    <div key={connection.grant.id} className="set-mcp-access__item">
      <div className="set-mcp-access__row">
        <span className="set-mcp-access__name">{connectionName(connection)}</span>
        {connection.grant.installation && (
          <SettingsButton
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => connect(connection.grant.installation!.client)}
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
      {heading && <SettingsSectionHeader title={t('settings.agent.mcpAccess.title')} hint="MCP" />}
      <p className="set-row__desc">
        {t('settings.agent.mcpAccess.desc')}
      </p>
      <p className="set-row__desc set-mcp-access__note">
        {t('settings.agent.mcpAccess.projectionDescription')}
      </p>
      {rows.clients.map(({ client, name: clientName, connection }) => connection
        ? renderConnection(connection)
        : (
          <div key={client} className="set-mcp-access__item set-mcp-access__row">
            <span className="set-mcp-access__name">{clientName}</span>
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
            <SettingsButton
              size="sm"
              disabled={busy || !name.trim()}
              onClick={() => void run(async () => {
                const connection = await platform.mcpServer.create({ name: name.trim() });
                setSelected(connection.grant.id);
                setName('');
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
