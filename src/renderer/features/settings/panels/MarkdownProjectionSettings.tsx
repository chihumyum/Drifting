import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { platform } from '../../../platform';
import type { MarkdownFolderSettings } from '../../../platform/contracts';
import { getPlatformRuntime } from '../../../platform/runtime';
import { useProjectStore } from '../../../store/project-store';
import { requestConfirmation } from '../../../store/confirmation-store';
import { getMarkdownProjectionStatus, subscribeMarkdownProjectionStatus } from '../../../services/markdown-projection-status';
import { SettingsButton, SettingsNote, SettingsRow } from '../SettingsPrimitives';

const service = () => import('../../../services/markdown-projection.service');

/** Runs one action at a time and reports its failure or success below it. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = async (action: () => Promise<string | void>) => {
    setBusy(true);
    setMessage('');
    setFailed(false);
    try {
      const done = await action();
      if (mounted.current && done) setMessage(done);
    } catch (error) {
      if (mounted.current) { setFailed(true); setMessage(error instanceof Error ? error.message : String(error)); }
    } finally { if (mounted.current) setBusy(false); }
  };
  const report = message ? <p role={failed ? 'alert' : 'status'} className="set-row__desc" style={{ marginTop: 8 }}>{message}</p> : null;
  return { busy, run, report, mounted };
}

/**
 * Where every project's Markdown folder goes, the open project's own folder,
 * and the switch for all of them. There is no default location: until the
 * author chooses one, projects without their own are not written. Turning the
 * folder off is the danger action and asks first: external editors and Agents
 * then lose the book.
 */
export function MarkdownProjectionSettings({ projectRuntimeMounted }: { projectRuntimeMounted: boolean }) {
  if (getPlatformRuntime().target !== 'desktop') return null;
  return <MarkdownFolderSection projectRuntimeMounted={projectRuntimeMounted} />;
}

function MarkdownFolderSection({ projectRuntimeMounted }: { projectRuntimeMounted: boolean }) {
  const { t } = useTranslation();
  const project = useProjectStore(state => state.currentProject);
  const [folder, setFolder] = useState<MarkdownFolderSettings | null>(null);
  const [loadError, setLoadError] = useState('');
  const { busy, run, report, mounted } = useAction();
  useEffect(() => {
    let live = true;
    platform.markdownProjection.folder().then(
      next => { if (live) setFolder(next); },
      error => { if (live) setLoadError(error instanceof Error ? error.message : String(error)); },
    );
    return () => { live = false; };
  }, []);
  const openProject = project && projectRuntimeMounted ? project : null;
  const projection = useSyncExternalStore(subscribeMarkdownProjectionStatus,
    () => (openProject ? getMarkdownProjectionStatus(openProject.id) : undefined));
  // Finder opens the project's folder, else the folder holding projects: one of them must exist.
  const revealable = Boolean(folder?.directory || projection?.directory);
  const change = (action: () => Promise<MarkdownFolderSettings>, done?: string) => run(async () => {
    const next = await action();
    if (mounted.current) setFolder(next);
    return done;
  });
  const chooseDefault = () => run(async () => {
    const root = await platform.markdownProjection.pickOutputRoot(t('settings.sync.projection.choose'));
    if (root === null) return;
    const next = await (await service()).setMarkdownFolderDefaultRoot(root);
    if (mounted.current) setFolder(next);
    return t('settings.sync.projection.changed');
  });
  const turnOff = () => run(async () => {
    const confirmed = await requestConfirmation(t('settings.sync.projection.offWarning'), {
      title: t('settings.sync.projection.offTitle'),
      confirmLabel: t('settings.sync.projection.turnOff'),
      destructive: true,
    });
    if (!confirmed) return;
    const next = await (await service()).setMarkdownFolderEnabled(false);
    if (mounted.current) setFolder(next);
  });

  return (
    <div>
      <SettingsRow
        label={t('settings.sync.projection.title')}
        desc={t('settings.sync.projection.description')}
        control={folder?.enabled === false ? (
          <SettingsButton variant="primary" disabled={busy} onClick={() => void change(async () => (await service()).setMarkdownFolderEnabled(true))}>
            {t('settings.sync.projection.turnOn')}
          </SettingsButton>
        ) : (
          <SettingsButton disabled={busy || !revealable} onClick={() => void run(() => platform.markdownProjection.open(openProject?.id ?? null))}>
            {t('settings.sync.projection.reveal')}
          </SettingsButton>
        )}
      />
      {loadError && <p role="alert" className="set-row__desc" style={{ marginTop: 8 }}>{loadError}</p>}
      {folder?.enabled === false && <SettingsNote role="status">{t('settings.sync.projection.offHint')}</SettingsNote>}
      {folder?.enabled && (
        <>
          <div style={{ marginTop: 8 }}>
            <div className="set-row__desc">
              {t(folder.directory ? 'settings.sync.projection.allProjects' : 'settings.sync.projection.allProjectsUnset')}
            </div>
            {folder.directory && <code style={{ display: 'block', overflowWrap: 'anywhere', fontSize: 12, marginTop: 4 }}>{folder.directory}</code>}
          </div>
          <p className="set-row__desc" style={{ marginTop: 4 }}>{t('settings.sync.projection.locationHint')}</p>
          <div className="set-actions set-actions--below">
            <SettingsButton variant={folder.directory ? undefined : 'primary'} disabled={busy} onClick={() => void chooseDefault()}>{t('settings.sync.projection.choose')}</SettingsButton>
          </div>
        </>
      )}
      {report}
      {folder?.enabled && (openProject
        ? <ProjectProjectionSettings key={openProject.id} projectId={openProject.id} projectName={openProject.name} />
        : <p className="set-row__desc" style={{ marginTop: 12 }}>{t('settings.sync.projection.openProject')}</p>)}
      {folder?.enabled && (
        <div className="set-actions set-actions--below" style={{ marginTop: 16 }}>
          <SettingsButton variant="danger" disabled={busy} onClick={() => void turnOff()}>{t('settings.sync.projection.turnOff')}</SettingsButton>
        </div>
      )}
    </div>
  );
}

function ProjectProjectionSettings({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { t, i18n } = useTranslation();
  const projection = useSyncExternalStore(subscribeMarkdownProjectionStatus,
    () => getMarkdownProjectionStatus(projectId));
  const { busy, run, report } = useAction();
  const changeRoot = async (root: string | null) => {
    await (await service()).setMarkdownProjectionOutputRoot(projectId, root);
    return t('settings.sync.projection.changed');
  };
  return (
    <div style={{ marginTop: 16 }}>
      <div className="set-row__desc">{t(projection?.customRoot ? 'settings.sync.projection.projectCustom' : 'settings.sync.projection.projectDefault', { project: projectName })}</div>
      {projection?.directory && (
        <code style={{ display: 'block', overflowWrap: 'anywhere', fontSize: 12, marginTop: 4 }}>{projection.directory}</code>
      )}
      <p role="status" className="set-row__desc" style={{ marginTop: 8 }}>
        {t(`settings.sync.projection.${projection?.state === 'ready' || projection?.state === 'error' || projection?.state === 'unset' ? projection.state : 'pending'}`)}
        {projection?.generatedAt ? ` · ${new Date(projection.generatedAt).toLocaleString(i18n.language)}` : ''}
        {projection?.error ? ` · ${projection.error}` : ''}
      </p>
      {projection?.mirrorIssues?.map(issue => (
        <p key={issue.path} role="alert" className="set-row__desc" style={{ marginTop: 4, overflowWrap: 'anywhere' }}>
          {t(`settings.sync.projection.issue.${issue.reason}`, { path: issue.path, defaultValue: t('settings.sync.projection.issue.unreadable', { path: issue.path }) })}
        </p>
      ))}
      {projection?.preserved?.length ? (
        <p className="set-row__desc" style={{ marginTop: 4 }}>{t('settings.sync.projection.preserved', { count: projection.preserved.length })}</p>
      ) : null}
      <div className="set-actions set-actions--below">
        <SettingsButton disabled={busy || !projection} onClick={() => void run(async () => {
          const root = await platform.markdownProjection.pickOutputRoot(t('settings.sync.projection.chooseProject'));
          if (root !== null) return changeRoot(root);
        })}>{t('settings.sync.projection.chooseProject')}</SettingsButton>
        <SettingsButton disabled={busy || (!projection?.customRoot && projection?.state !== 'error')} onClick={() => void run(() => changeRoot(null))}>
          {t('settings.sync.projection.resetProject')}
        </SettingsButton>
        <SettingsButton disabled={busy || !projection?.directory} onClick={() => void run(async () => {
          await navigator.clipboard.writeText(projection!.directory!);
          return t('settings.sync.projection.copied');
        })}>{t('settings.sync.projection.copy')}</SettingsButton>
        <SettingsButton disabled={busy || !projection || projection.state === 'unset'} onClick={() => void run(async () => {
          await (await service()).refreshMarkdownProjection(projectId);
        })}>{t('settings.sync.projection.refresh')}</SettingsButton>
      </div>
      {report}
    </div>
  );
}
