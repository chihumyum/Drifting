import { useRef, useState, type FormEvent } from 'react';
import { MoreHorizontal, Pencil, Target, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Project } from '../../../domain/project';
import { AnchoredPopover } from '../../../components/ui/AnchoredPopover';
import { Button } from '../../../components/ui/Button';
import { ModalActions, ModalBody, ModalCard, ModalHeader, ModalRoot } from '../../../components/ui/Modal';
import { useProjectStore } from '../../../store/project-store';
import { useWritingStatsStore } from '../../../store/writing-stats-store';
import { useProject } from '../../../usecase/useProject';

type ProjectDialog = 'details' | 'goals' | 'delete';

function ProjectActionDialog({
  project,
  view,
  onClose,
  onProjectDeleted,
}: {
  project: Project;
  view: ProjectDialog;
  onClose(): void;
  onProjectDeleted(): void;
}) {
  const { t } = useTranslation();
  const { updateProject, deleteProject } = useProject({ userId: project.userId });
  const [plan] = useState(() => useWritingStatsStore.getState().getPlan(project.id));
  const [name, setName] = useState(project.name);
  const [summary, setSummary] = useState(project.summary);
  const [projectTarget, setProjectTarget] = useState(String(plan.projectWordTarget));
  const [dailyTarget, setDailyTarget] = useState(String(plan.dailyWordGoal));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const title = t(`mobileWorkspace.projectActions.${view}`);
  const dismiss = () => { if (!busyRef.current) onClose(); };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busyRef.current) return;
    if (view === 'details' && !name.trim()) return;
    const words = [Number(projectTarget), Number(dailyTarget)];
    if (view === 'goals' && words.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      setError(t('mobileWorkspace.projectActions.invalidGoal'));
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (view === 'delete') {
        const deleted = await deleteProject(project.id);
        if (!deleted) throw new Error('Project deletion did not commit');
        onProjectDeleted();
        return;
      }
      if (view === 'details') {
        const updated = await updateProject(project.id, { name: name.trim(), summary: summary.trim() });
        if (!updated) throw new Error('Project update did not commit');
      } else {
        const store = useWritingStatsStore.getState();
        store.setProjectWordTarget(project.id, words[0]);
        store.setDailyWordGoal(project.id, words[1]);
      }
      onClose();
    } catch {
      setError(t(view === 'delete'
        ? 'mobileWorkspace.projectActions.deleteFailed'
        : 'mobileWorkspace.projectActions.saveFailed'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <ModalRoot onClose={dismiss} ariaLabel={title} className="m-project-action-dialog">
      <ModalCard width={440}>
        <form onSubmit={(event) => { void submit(event); }} aria-busy={busy}>
          <ModalHeader title={title} subtitle={project.name} />
          <ModalBody className="m-project-action-dialog__body">
            {view === 'details' && (
              <>
                <label>
                  <span>{t('dashboard.hero.projectName')}</span>
                  <input
                    name="projectName"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    required
                    disabled={busy}
                  />
                </label>
                <label>
                  <span>{t('mobileWorkspace.projectActions.summary')}</span>
                  <textarea
                    name="projectSummary"
                    value={summary}
                    onChange={(event) => setSummary(event.target.value)}
                    rows={4}
                    disabled={busy}
                  />
                </label>
              </>
            )}
            {view === 'goals' && (
              <>
                <label>
                  <span>{t('dashboard.plan.projectTarget')}</span>
                  <input name="projectTarget" type="number" inputMode="numeric" min={0} step={1}
                    required value={projectTarget} disabled={busy}
                    onChange={(event) => setProjectTarget(event.target.value)} />
                  <small>{t('dashboard.plan.projectHint')}</small>
                </label>
                <label>
                  <span>{t('dashboard.plan.dailyTarget')}</span>
                  <input name="dailyTarget" type="number" inputMode="numeric" min={0} step={1}
                    required value={dailyTarget} disabled={busy}
                    onChange={(event) => setDailyTarget(event.target.value)} />
                  <small>{t('dashboard.plan.dailyHint')}</small>
                </label>
                <p>{t('mobileWorkspace.projectActions.goalsDevice')}</p>
              </>
            )}
            {view === 'delete' && <p>{t('mobileWorkspace.projectActions.deleteBody', { name: project.name })}</p>}
            {error && <p role="alert" className="m-project-action-dialog__error">{error}</p>}
          </ModalBody>
          <ModalActions>
            <Button onClick={dismiss} disabled={busy} autoFocus>{t('common.cancel')}</Button>
            <Button type="submit" variant={view === 'delete' ? 'danger' : 'primary'}
              disabled={busy || (view === 'details' && !name.trim())}>
              {busy ? t(view === 'delete' ? 'projectPicker.delete.deleting' : 'common.saving')
                : t(view === 'delete' ? 'mobileWorkspace.projectActions.delete' : 'common.save')}
            </Button>
          </ModalActions>
        </form>
      </ModalCard>
    </ModalRoot>
  );
}

/** Project management belongs to Home; application preferences retain their
 * independent Settings entry. All writes use the existing project owners. */
export function MobileProjectActions({
  onOpenTrash,
  onProjectDeleted,
}: {
  onOpenTrash(): void;
  onProjectDeleted(): void;
}) {
  const { t } = useTranslation();
  const project = useProjectStore((state) => state.currentProject);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<ProjectDialog | null>(null);
  const openDialog = (view: ProjectDialog) => { setMenuOpen(false); setDialog(view); };
  if (!project) return null;

  return (
    <>
      <button ref={anchorRef} type="button" className="m-project-actions-trigger"
        data-debug-id="mobile-project-actions"
        aria-label={t('mobileWorkspace.projectActions.menu')}
        aria-haspopup="menu" aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}>
        <MoreHorizontal size={19} aria-hidden="true" />
      </button>
      <AnchoredPopover anchorRef={anchorRef} open={menuOpen} onClose={() => setMenuOpen(false)}
        placement="bottom-end" role="menu" className="menu-surface menu-surface--standard m-project-actions-menu"
        ariaLabel={t('mobileWorkspace.projectActions.menu')}>
        <button type="button" role="menuitem" className="menu-surface__item" onClick={() => openDialog('details')}>
          <Pencil size={16} aria-hidden="true" />{t('mobileWorkspace.projectActions.details')}
        </button>
        <button type="button" role="menuitem" className="menu-surface__item" onClick={() => openDialog('goals')}>
          <Target size={16} aria-hidden="true" />{t('mobileWorkspace.projectActions.goals')}
        </button>
        <button type="button" role="menuitem" className="menu-surface__item" onClick={() => { setMenuOpen(false); onOpenTrash(); }}>
          <Trash2 size={16} aria-hidden="true" />{t('mobileWorkspace.projectActions.trash')}
        </button>
        <hr className="menu-surface__separator" />
        <button type="button" role="menuitem" className="menu-surface__item menu-surface__item--danger"
          onClick={() => openDialog('delete')}>
          <Trash2 size={16} aria-hidden="true" />{t('mobileWorkspace.projectActions.delete')}
        </button>
      </AnchoredPopover>
      {dialog && <ProjectActionDialog key={dialog} project={project} view={dialog}
        onClose={() => {
          setDialog(null);
          anchorRef.current?.focus({ preventScroll: true });
        }} onProjectDeleted={onProjectDeleted} />}
    </>
  );
}
