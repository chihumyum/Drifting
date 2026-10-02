import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { platform } from '../../../platform';
import { getPlatformRuntime } from '../../../platform/runtime';
import { useProjectStore } from '../../../store/project-store';
import { getMarkdownProjectionStatus, subscribeMarkdownProjectionStatus } from '../../../services/markdown-projection-status';
import { SettingsRow } from '../SettingsPrimitives';

export function MarkdownProjectionSettings({ projectRuntimeMounted }: { projectRuntimeMounted: boolean }) {
  const { t } = useTranslation();
  const project = useProjectStore(state => state.currentProject);
  if (getPlatformRuntime().target !== 'desktop') return null;
  if (!project || !projectRuntimeMounted) {
    return <SettingsRow label={t('settings.sync.projection.title')} desc={t('settings.sync.projection.openProject')} />;
  }
  return <ProjectProjectionSettings key={project.id} projectId={project.id} projectName={project.name} />;
}

function ProjectProjectionSettings({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { t } = useTranslation();
  const projection = useSyncExternalStore(subscribeMarkdownProjectionStatus,
    () => getMarkdownProjectionStatus(projectId));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setMessage('');
    setFailed(false);
    try { await action(); }
    catch (error) {
      if (mounted.current) { setFailed(true); setMessage(error instanceof Error ? error.message : String(error)); }
    } finally { if (mounted.current) setBusy(false); }
  };
  const changeRoot = async (root: string | null) => {
    const { setMarkdownProjectionOutputRoot } = await import('../../../services/markdown-projection.service');
    await setMarkdownProjectionOutputRoot(projectId, root);
    if (mounted.current) setMessage(t('settings.sync.projection.changed'));
  };
  return (
    <div>
      <SettingsRow
        label={t('settings.sync.projection.title')}
        desc={t('settings.sync.projection.description', { project: projectName })}
      />
      <p className="set-row__desc">{t('settings.sync.projection.locationHint')}</p>
      {projection?.directory && (
        <div style={{ marginTop: 8 }}>
          <div className="set-row__desc">{t(projection.customRoot ? 'settings.sync.projection.customLocation' : 'settings.sync.projection.defaultLocation')}</div>
          <code style={{ display: 'block', overflowWrap: 'anywhere', fontSize: 12, marginTop: 4 }}>{projection.directory}</code>
        </div>
      )}
      <p role="status" className="set-row__desc" style={{ marginTop: 8 }}>
        {t(`settings.sync.projection.${projection?.state === 'ready' ? 'ready' : projection?.state === 'error' ? 'error' : 'pending'}`)}
        {projection?.generatedAt ? ` · ${new Date(projection.generatedAt).toLocaleString()}` : ''}
        {projection?.error ? ` · ${projection.error}` : ''}
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
        <button className="set-btn" disabled={busy || !projection} onClick={() => void run(async () => {
          const root = await platform.markdownProjection.pickOutputRoot(t('settings.sync.projection.choose'));
          if (root !== null && mounted.current) await changeRoot(root);
        })}>{t('settings.sync.projection.choose')}</button>
        <button className="set-btn" disabled={busy || (!projection?.customRoot && projection?.state !== 'error')} onClick={() => void run(() => changeRoot(null))}>
          {t('settings.sync.projection.reset')}
        </button>
        <button className="set-btn" disabled={busy || !projection?.directory} onClick={() => void run(async () => {
          await navigator.clipboard.writeText(projection!.directory!);
          if (mounted.current) setMessage(t('settings.sync.projection.copied'));
        })}>{t('settings.sync.projection.copy')}</button>
        <button className="set-btn" disabled={busy || !projection} onClick={() => void run(async () => {
          const { refreshMarkdownProjection } = await import('../../../services/markdown-projection.service');
          await refreshMarkdownProjection(projectId);
        })}>{t('settings.sync.projection.refresh')}</button>
      </div>
      {message && <p role={failed ? 'alert' : 'status'} className="set-row__desc" style={{ marginTop: 8 }}>{message}</p>}
    </div>
  );
}
