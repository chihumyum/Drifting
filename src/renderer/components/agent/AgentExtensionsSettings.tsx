import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { uuidv7 } from 'uuidv7';

import type {
  AgentMcpServerConfig,
  AgentMcpServerDraft,
  AgentMcpToolPolicy,
  AgentPermissionGrant,
} from '../../domain/agent-extension';
import { getDriftingAgentExtensionPlatform } from '../../lib/agent/useDriftingAgentRuntime';
import { platform } from '../../platform';
import { useProjectStore } from '../../store/project-store';
import { requestConfirmation } from '../../store/confirmation-store';
import { BrushIcon, type BrushIconName } from '../ui/BrushIcon';
import { EmptyState } from '../ui/EmptyState';
import { Switch } from '../ui/Switch';
import {
  SettingsButton,
  SettingsConfigField,
  SettingsField,
  SettingsNote,
  SettingsSelect,
} from '../../features/settings/SettingsPrimitives';

interface ServerForm {
  id: string;
  name: string;
  transport: 'stdio' | 'streamable_http';
  command: string;
  args: string;
  cwd: string;
  url: string;
  publicValues: string;
  secretValues: string;
}

const EMPTY_FORM: ServerForm = {
  id: '',
  name: '',
  transport: 'streamable_http',
  command: '',
  args: '',
  cwd: '',
  url: '',
  publicValues: '',
  secretValues: '',
};

/** Health is a sand status icon and one word in index type, no chip. */
const HEALTH_ICON: Record<string, BrushIconName> = {
  healthy: 'status-done',
  connecting: 'loader',
  degraded: 'status-warning',
  failed: 'status-stopped',
  disabled: 'minus',
};

const TRANSPORT_LABEL: Record<ServerForm['transport'], string> = {
  streamable_http: 'Streamable HTTP',
  stdio: 'stdio (desktop)',
};

const POLICY_OPTIONS: Array<{ value: string; labelKey: string }> = [
  { value: 'read:automatic', labelKey: 'settings.agent.extensions.policy.autoRead' },
  { value: 'read:ask', labelKey: 'settings.agent.extensions.policy.askRead' },
  { value: 'write:ask', labelKey: 'settings.agent.extensions.policy.askWrite' },
  { value: 'deny:deny', labelKey: 'settings.agent.extensions.policy.disabled' },
];

export function AgentExtensionsSettings({ open }: { open: boolean }) {
  const { t } = useTranslation();
  const navigationId = useId();
  const projectId = useProjectStore((state) => state.currentProject?.id ?? '');
  const extensionPlatform = useMemo(() => getDriftingAgentExtensionPlatform(), []);
  const [servers, setServers] = useState<AgentMcpServerConfig[]>([]);
  const [grants, setGrants] = useState<AgentPermissionGrant[]>([]);
  const [statuses, setStatuses] = useState(extensionPlatform.manager.getSnapshot());
  const [form, setForm] = useState<ServerForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    if (!projectId) {
      setServers([]);
      setGrants([]);
      return;
    }
    const [nextServers, nextGrants] = await Promise.all([
      extensionPlatform.repository.listServers(projectId),
      extensionPlatform.repository.listGrants(projectId),
    ]);
    setServers(nextServers);
    setGrants(nextGrants);
  }, [extensionPlatform, projectId]);

  useEffect(() => {
    const sync = () => setStatuses(extensionPlatform.manager.getSnapshot());
    sync();
    return extensionPlatform.manager.subscribe(sync);
  }, [extensionPlatform]);

  useEffect(() => {
    if (!open || !projectId) return;
    const timer = globalThis.setTimeout(() => {
      void reload().catch(() => setError(t('settings.agent.extensions.loadFailed')));
    }, 0);
    return () => globalThis.clearTimeout(timer);
  }, [open, projectId, reload, t]);

  const mutate = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await operation();
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const editServer = (server: AgentMcpServerConfig) => {
    setError('');
    setForm({
      id: server.id,
      name: server.name,
      transport: server.transport,
      command: server.command ?? '',
      args: server.args.join('\n'),
      cwd: server.cwd ?? '',
      url: server.url ?? '',
      publicValues: formatAssignments(
        server.transport === 'stdio' ? server.publicEnv : server.publicHeaders,
      ),
      secretValues: formatSecretAssignments(
        server.transport === 'stdio' ? server.secretEnv : server.secretHeaders,
      ),
    });
  };

  const saveForm = () => {
    if (!form || !projectId) return;
    void mutate(async () => {
      const existing = servers.find((server) => server.id === form.id);
      const id = form.id || uuidv7();
      const oldRefs = {
        ...(existing?.secretEnv ?? {}),
        ...(existing?.secretHeaders ?? {}),
      };
      const secretEntries = parseAssignments(form.secretValues, true);
      const secretRefs: Record<string, string> = {};
      const rollback: Array<{ key: string; previous: string | null }> = [];
      for (const [name, value] of Object.entries(secretEntries)) {
        const key = oldRefs[name] ?? secretKey(projectId, id, form.transport, name);
        secretRefs[name] = key;
        if (!value) {
          if (!oldRefs[name]) throw new Error(`Secret "${name}" needs a value`);
          continue;
        }
        const previous = await platform.keychain.get(key);
        rollback.push({ key, previous });
        await platform.keychain.set(key, value);
      }
      const publicValues = parseAssignments(form.publicValues, false);
      const draft: AgentMcpServerDraft = {
        id,
        projectId,
        name: form.name,
        transport: form.transport,
        enabled: existing?.enabled ?? true,
        command: form.transport === 'stdio' ? form.command : null,
        args:
          form.transport === 'stdio'
            ? form.args
                .split('\n')
                .map((value) => value.trim())
                .filter(Boolean)
            : [],
        cwd: form.transport === 'stdio' && form.cwd.trim() ? form.cwd : null,
        publicEnv: form.transport === 'stdio' ? publicValues : {},
        secretEnv: form.transport === 'stdio' ? secretRefs : {},
        url: form.transport === 'streamable_http' ? form.url : null,
        publicHeaders: form.transport === 'streamable_http' ? publicValues : {},
        secretHeaders: form.transport === 'streamable_http' ? secretRefs : {},
        toolPolicy: existing?.toolPolicy ?? {},
      };
      try {
        await extensionPlatform.repository.saveServer(draft);
      } catch (cause) {
        await Promise.all(
          rollback.map(({ key, previous }) =>
            previous == null ? platform.keychain.delete(key) : platform.keychain.set(key, previous),
          ),
        );
        throw cause;
      }
      const removedRefs = Object.entries(oldRefs).filter(([name]) => !secretRefs[name]);
      await Promise.all(removedRefs.map(([, key]) => platform.keychain.delete(key)));
      await extensionPlatform.manager.reconnect(projectId, id);
      setForm(null);
    });
  };

  const toggleServer = (server: AgentMcpServerConfig) => {
    void mutate(async () => {
      await extensionPlatform.repository.saveServer({
        ...serverDraft(server),
        enabled: !server.enabled,
      });
      await extensionPlatform.manager.reconnect(projectId, server.id);
    });
  };

  const deleteServer = async (server: AgentMcpServerConfig) => {
    const confirmed = await requestConfirmation(
      t('settings.agent.extensions.deleteConfirm', { name: server.name }),
    );
    if (!confirmed) return;
    void mutate(async () => {
      const refs = [...Object.values(server.secretEnv), ...Object.values(server.secretHeaders)];
      await extensionPlatform.repository.deleteServer(projectId, server.id);
      await extensionPlatform.manager.reconnect(projectId, server.id);
      await Promise.all(refs.map((key) => platform.keychain.delete(key)));
      if (form?.id === server.id) setForm(null);
    });
  };

  const updateToolPolicy = (server: AgentMcpServerConfig, toolName: string, encoded: string) => {
    void mutate(async () => {
      const [access, approval] = encoded.split(':');
      const policy: AgentMcpToolPolicy =
        access === 'deny'
          ? { access: 'write', approval: 'deny' }
          : {
              access: access === 'read' ? 'read' : 'write',
              approval: approval === 'automatic' ? 'automatic' : 'ask',
            };
      await extensionPlatform.repository.saveServer({
        ...serverDraft(server),
        toolPolicy: { ...server.toolPolicy, [toolName]: policy },
      });
      await extensionPlatform.manager.reconnect(projectId, server.id);
    });
  };

  const revokeGrant = (grantId: string) => {
    void mutate(async () => {
      await extensionPlatform.repository.revokeGrant(
        projectId,
        grantId,
        'Revoked from Agent extension settings',
      );
    });
  };

  return (
    <>
      <div className="set-sec">
        <div className="set-sec__head" id={`${navigationId}-servers`} data-settings-section={t('settings.agent.extensions.title')}>
          <div>
            <div className="set-sec__title">{t('settings.agent.extensions.title')}</div>
            <div className="set-row__desc">{t('settings.agent.extensions.desc')}</div>
          </div>
          <SettingsButton
            variant="ghost"
            size="sm"
            disabled={!projectId || busy}
            onClick={() => setForm({ ...EMPTY_FORM })}
          >
            <BrushIcon name="plus" size={12} />
            {t('settings.agent.extensions.add')}
          </SettingsButton>
        </div>

        {error && (
          <SettingsNote icon="status-stopped" tone="error" role="alert">
            {error}
          </SettingsNote>
        )}
        {!projectId && <EmptyState density="compact" message={t('settings.agent.extensions.noProject')} />}
        {projectId && servers.length === 0 && !form && (
          <EmptyState density="compact" message={t('settings.agent.extensions.empty')} />
        )}

        <div className="set-agent-ext__servers">
          {servers.map((server) => {
            const live = statuses.find((status) => status.serverId === server.id);
            const status = server.enabled ? (live?.status ?? server.healthStatus) : 'disabled';
            return (
              // A card that is not a button: the resting line, flowing under the pointer.
              <div className="set-agent-ext__server glass glass--rest glass--surface" key={server.id}>
                <div className="set-agent-ext__server-head">
                  <div className="set-agent-ext__identity">
                    <div className="set-agent-ext__name">{server.name}</div>
                    <div className="set-agent-ext__meta">{TRANSPORT_LABEL[server.transport]}</div>
                  </div>
                  <span className={`set-agent-ext__health set-agent-ext__health--${status}`}>
                    <BrushIcon
                      name={HEALTH_ICON[status] ?? 'status-warning'}
                      size={13}
                      className={status === 'connecting' ? 'ui-spin' : undefined}
                    />
                    {status}
                  </span>
                  <Switch
                    checked={server.enabled}
                    disabled={busy}
                    aria-label={`${server.enabled ? t('settings.agent.extensions.disable') : t('settings.agent.extensions.enable')} ${server.name}`}
                    onCheckedChange={() => toggleServer(server)}
                  />
                </div>
                <div className="set-agent-ext__message">
                  {live?.message || server.healthMessage || t('settings.agent.extensions.notChecked')}
                </div>

                {server.discoveredTools.length > 0 && (
                  <div className="set-agent-ext__tools">
                    {server.discoveredTools.map((tool) => {
                      const policy = server.toolPolicy[tool.name];
                      const value = policy
                        ? policy.approval === 'deny'
                          ? 'deny:deny'
                          : `${policy.access}:${policy.approval}`
                        : 'write:ask';
                      return (
                        <div className="set-agent-ext__tool" key={tool.name}>
                          <span>
                            <strong>{tool.name}</strong>
                            <small>{tool.description}</small>
                          </span>
                          <SettingsSelect
                            few
                            value={value}
                            disabled={busy}
                            ariaLabel={tool.name}
                            onChange={(next) => updateToolPolicy(server, tool.name, next)}
                            options={POLICY_OPTIONS.map((option) => ({
                              value: option.value,
                              label: t(option.labelKey),
                            }))}
                          />
                        </div>
                      );
                    })}
                  </div>
                )}

                <div className="set-agent-ext__actions">
                  <SettingsButton variant="ghost" size="sm" disabled={busy} onClick={() => editServer(server)}>
                    {t('settings.common.edit')}
                  </SettingsButton>
                  <SettingsButton
                    variant="ghost"
                    size="sm"
                    disabled={busy || !server.enabled}
                    onClick={() => void mutate(() => extensionPlatform.manager.reconnect(projectId, server.id))}
                  >
                    {t('settings.agent.extensions.reconnect')}
                  </SettingsButton>
                  <span className="set-agent-ext__spacer" />
                  <SettingsButton variant="danger" size="sm" disabled={busy} onClick={() => void deleteServer(server)}>
                    {t('settings.common.delete')}
                  </SettingsButton>
                </div>
              </div>
            );
          })}
        </div>

        {form && (
          <div className="set-agent-ext__form glass glass--rest glass--surface">
            <div className="set-agent-ext__form-title">
              {form.id
                ? t('settings.agent.extensions.editTitle')
                : t('settings.agent.extensions.addTitle')}
            </div>
            <div className="set-agent-ext__field">
              <span>{t('settings.agent.extensions.name')}</span>
              <SettingsField
                wide
                aria-label={t('settings.agent.extensions.name')}
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </div>
            <div className="set-agent-ext__field">
              <span>{t('settings.agent.extensions.transport')}</span>
              <SettingsSelect<ServerForm['transport']>
                few
                ariaLabel={t('settings.agent.extensions.transport')}
                value={form.transport}
                onChange={(transport) =>
                  setForm({ ...form, transport, publicValues: '', secretValues: '' })
                }
                options={[
                  { value: 'streamable_http', label: TRANSPORT_LABEL.streamable_http },
                  { value: 'stdio', label: TRANSPORT_LABEL.stdio },
                ]}
              />
            </div>
            {form.transport === 'stdio' ? (
              <>
                <div className="set-agent-ext__field">
                  <span>{t('settings.agent.extensions.command')}</span>
                  <SettingsField
                    wide
                    mono
                    aria-label={t('settings.agent.extensions.command')}
                    placeholder="/absolute/path/to/executable"
                    value={form.command}
                    onChange={(event) => setForm({ ...form, command: event.target.value })}
                  />
                </div>
                <div className="set-agent-ext__field">
                  <span>{t('settings.agent.extensions.args')}</span>
                  <SettingsConfigField
                    rows={3}
                    aria-label={t('settings.agent.extensions.args')}
                    value={form.args}
                    onChange={(event) => setForm({ ...form, args: event.target.value })}
                  />
                </div>
                <div className="set-agent-ext__field">
                  <span>{t('settings.agent.extensions.cwd')}</span>
                  <SettingsField
                    wide
                    mono
                    aria-label={t('settings.agent.extensions.cwd')}
                    value={form.cwd}
                    onChange={(event) => setForm({ ...form, cwd: event.target.value })}
                  />
                </div>
              </>
            ) : (
              <div className="set-agent-ext__field">
                <span>{t('settings.agent.extensions.url')}</span>
                <SettingsField
                  wide
                  mono
                  aria-label={t('settings.agent.extensions.url')}
                  placeholder="https://example.com/mcp"
                  value={form.url}
                  onChange={(event) => setForm({ ...form, url: event.target.value })}
                />
              </div>
            )}
            <div className="set-agent-ext__field">
              <span>
                {form.transport === 'stdio'
                  ? t('settings.agent.extensions.publicEnv')
                  : t('settings.agent.extensions.publicHeaders')}
              </span>
              <SettingsConfigField
                rows={3}
                aria-label={
                  form.transport === 'stdio'
                    ? t('settings.agent.extensions.publicEnv')
                    : t('settings.agent.extensions.publicHeaders')
                }
                placeholder="NAME=value"
                value={form.publicValues}
                onChange={(event) => setForm({ ...form, publicValues: event.target.value })}
              />
            </div>
            <div className="set-agent-ext__field">
              <span>
                {form.transport === 'stdio'
                  ? t('settings.agent.extensions.secretEnv')
                  : t('settings.agent.extensions.secretHeaders')}
              </span>
              <SettingsConfigField
                rows={3}
                aria-label={
                  form.transport === 'stdio'
                    ? t('settings.agent.extensions.secretEnv')
                    : t('settings.agent.extensions.secretHeaders')
                }
                placeholder="TOKEN=secret value"
                value={form.secretValues}
                onChange={(event) => setForm({ ...form, secretValues: event.target.value })}
              />
              <small>{t('settings.agent.extensions.secretHint')}</small>
            </div>
            <div className="set-agent-ext__actions">
              <SettingsButton variant="primary" disabled={busy || !form.name.trim()} onClick={saveForm}>
                {t('settings.common.save')}
              </SettingsButton>
              <SettingsButton variant="ghost" disabled={busy} onClick={() => setForm(null)}>
                {t('settings.common.cancel')}
              </SettingsButton>
            </div>
          </div>
        )}
      </div>

      <div className="set-sec">
        <div className="set-sec__head" id={`${navigationId}-grants`} data-settings-section={t('settings.agent.extensions.grantsTitle')}>
          <div>
            <div className="set-sec__title">{t('settings.agent.extensions.grantsTitle')}</div>
            <div className="set-row__desc">{t('settings.agent.extensions.grantsDesc')}</div>
          </div>
        </div>
        {grants.length === 0 ? (
          <EmptyState density="compact" message={t('settings.agent.extensions.noGrants')} />
        ) : (
          <div className="set-agent-ext__grants">
            {grants.map((grant) => (
              <div className="set-agent-ext__grant" key={grant.id}>
                <span>
                  <strong>{grant.remoteToolName}</strong>
                  <small>
                    {grant.scope} · {grant.access} · {grant.status}
                  </small>
                </span>
                {grant.status === 'active' && (
                  <SettingsButton variant="ghost" size="sm" disabled={busy} onClick={() => revokeGrant(grant.id)}>
                    {t('settings.agent.extensions.revoke')}
                  </SettingsButton>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function serverDraft(server: AgentMcpServerConfig): AgentMcpServerDraft {
  return {
    id: server.id,
    projectId: server.projectId,
    name: server.name,
    transport: server.transport,
    enabled: server.enabled,
    command: server.command,
    args: server.args,
    cwd: server.cwd,
    publicEnv: server.publicEnv,
    secretEnv: server.secretEnv,
    url: server.url,
    publicHeaders: server.publicHeaders,
    secretHeaders: server.secretHeaders,
    toolPolicy: server.toolPolicy,
  };
}

function parseAssignments(value: string, allowEmpty: boolean): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [index, raw] of value.split('\n').entries()) {
    const line = raw.trim();
    if (!line) continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error(`Line ${index + 1} must use NAME=value`);
    const name = line.slice(0, separator).trim();
    const item = line.slice(separator + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,200}$/u.test(name)) {
      throw new Error(`Line ${index + 1} has an invalid name`);
    }
    if (!allowEmpty && !item) throw new Error(`Line ${index + 1} needs a value`);
    if (
      item.length > 8_000 ||
      item.includes('\u0000') ||
      item.includes('\r') ||
      item.includes('\n')
    ) {
      throw new Error(`Line ${index + 1} has an invalid value`);
    }
    result[name] = item;
  }
  return result;
}

function formatAssignments(value: Readonly<Record<string, string>>): string {
  return Object.entries(value)
    .map(([name, item]) => `${name}=${item}`)
    .join('\n');
}

function formatSecretAssignments(value: Readonly<Record<string, string>>): string {
  return Object.keys(value)
    .map((name) => `${name}=`)
    .join('\n');
}

function secretKey(
  projectId: string,
  serverId: string,
  transport: ServerForm['transport'],
  name: string,
): string {
  return `drifting.mcp.${encodeURIComponent(projectId)}.${encodeURIComponent(serverId)}.${transport}.${encodeURIComponent(name)}`.slice(
    0,
    300,
  );
}
