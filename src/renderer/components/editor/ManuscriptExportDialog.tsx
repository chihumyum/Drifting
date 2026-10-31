import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { platform } from '../../platform';
import { useSettingsStore } from '../../store/settings-store';
import {
  defaultManuscriptChapterIds, manuscriptFilename, MANUSCRIPT_FORMATS,
  type ManuscriptCover, type ManuscriptFormat, type ManuscriptOutline,
} from '../../services/export/manuscript-export';
import { Button } from '../ui/Button';
import { BrushIcon } from '../ui/BrushIcon';
import { GlassSlider } from '../ui/GlassSlider';
import { KindMark } from '../ui/KindMark';
import { LoadingStatus } from '../ui/LoadingStatus';
import { ModalActions, ModalBody, ModalCard, ModalHeader, ModalRoot } from '../ui/Modal';
import { Switch } from '../ui/Switch';
import '../../../styles/manuscript-export.css';

export interface ManuscriptExportTarget {
  projectId: string;
  /** Opened from a chapter: "selected chapters" starts with just this one. */
  chapterId?: string;
}

type Scope = 'book' | 'selected';

interface StoredPreferences {
  author?: string;
  projects?: Record<string, {
    format?: ManuscriptFormat;
    actTitles?: boolean;
    chapterTitles?: boolean;
    outlineHeadings?: boolean;
    title?: string;
  }>;
}

const PREFERENCES_KEY = 'drifting.manuscriptExport.v1';

function loadPreferences(): StoredPreferences {
  try {
    const raw = window.localStorage.getItem(PREFERENCES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed as StoredPreferences : {};
  } catch {
    return {};
  }
}

function savePreferences(preferences: StoredPreferences) {
  try {
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Preferences are a convenience; exporting never depends on them.
  }
}

const FORMAT_LABELS: Record<ManuscriptFormat, string> = { epub: 'EPUB', pdf: 'PDF', docx: 'Word' };

export function ManuscriptExportDialog({ target, onClose }: {
  target: ManuscriptExportTarget;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [stored] = useState(loadPreferences);
  const projectPreferences = stored.projects?.[target.projectId] ?? {};
  const [outline, setOutline] = useState<ManuscriptOutline | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [format, setFormat] = useState<ManuscriptFormat>(projectPreferences.format ?? 'epub');
  const [scope, setScope] = useState<Scope>(target.chapterId ? 'selected' : 'book');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(target.chapterId ? [target.chapterId] : []));
  const [actTitles, setActTitles] = useState(projectPreferences.actTitles ?? true);
  const [chapterTitles, setChapterTitles] = useState(projectPreferences.chapterTitles ?? true);
  const [outlineHeadings, setOutlineHeadings] = useState(projectPreferences.outlineHeadings ?? false);
  const [title, setTitle] = useState(projectPreferences.title ?? '');
  const [author, setAuthor] = useState(stored.author ?? '');
  const [cover, setCover] = useState<ManuscriptCover | null>(null);
  const [busy, setBusy] = useState<'cover' | 'export' | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'saved' | 'failed' | 'coverFailed'; detail?: string } | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    let canceled = false;
    void import('../../services/export/manuscript-export.service')
      .then(module => module.readManuscriptOutline(target.projectId))
      .then((result) => {
        if (canceled) return;
        setOutline(result);
        setTitle(current => current || result.projectTitle);
        if (!target.chapterId) setSelected(new Set(defaultManuscriptChapterIds(result.chapters)));
      })
      .catch(() => { if (!canceled) setLoadError(true); });
    return () => { canceled = true; };
  }, [target.projectId, target.chapterId, attempt]);

  const chapterIds = useMemo(() => {
    if (!outline) return [];
    return scope === 'book'
      ? defaultManuscriptChapterIds(outline.chapters)
      : outline.chapters.filter(chapter => selected.has(chapter.id)).map(chapter => chapter.id);
  }, [outline, scope, selected]);
  const hasActs = (outline?.acts.length ?? 0) > 0;
  const running = busy !== null;
  const canExport = !!outline && chapterIds.length > 0 && title.trim().length > 0 && !running;

  const toggleChapter = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const pickCover = async () => {
    if (running) return;
    setBusy('cover');
    setFeedback(null);
    try {
      const result = await platform.sharing.pickManuscriptCover();
      if (!alive.current) return;
      if (result.ok) setCover(result.cover);
      else if (!result.canceled) setFeedback({ kind: 'coverFailed', detail: result.error });
    } catch (error) {
      if (alive.current) setFeedback({ kind: 'coverFailed', detail: error instanceof Error ? error.message : undefined });
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const runExport = async () => {
    if (!canExport || !outline) return;
    setBusy('export');
    setFeedback(null);
    savePreferences({
      ...stored,
      author: author.trim(),
      projects: {
        ...stored.projects,
        [target.projectId]: {
          format, actTitles, chapterTitles, outlineHeadings,
          ...(title.trim() && title.trim() !== outline.projectTitle ? { title: title.trim() } : {}),
        },
      },
    });
    try {
      const { readManuscript } = await import('../../services/export/manuscript-export.service');
      const settings = useSettingsStore.getState();
      const manuscript = await readManuscript(target.projectId, {
        chapterIds: scope === 'book' ? null : chapterIds,
        actTitles: hasActs && actTitles,
        chapterTitles,
        outlineHeadings,
        title,
        author,
        cover,
      }, {
        untitledChapter: t('manuscriptExport.untitledChapter'),
        untitledAct: t('manuscriptExport.untitledAct'),
      }, {
        locale: i18n.resolvedLanguage ?? i18n.language,
        preferredFont: settings.editorFontSource === 'system-custom' ? settings.editorSystemFontFamily : undefined,
      });
      const result = await platform.sharing.saveManuscript(
        format, manuscriptFilename(manuscript.title, format), JSON.stringify(manuscript));
      if (!alive.current) return;
      if (result.ok) setFeedback({ kind: 'saved' });
      else if (!result.canceled) setFeedback({ kind: 'failed', detail: result.error });
    } catch (error) {
      if (alive.current) setFeedback({ kind: 'failed', detail: error instanceof Error ? error.message : undefined });
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  // Chapters grouped under their acts, in book order.
  const groups = useMemo(() => {
    if (!outline) return [];
    const names = new Map(outline.acts.map(act => [act.id, act.name]));
    const list: { actId: string | null; name: string | null; chapters: ManuscriptOutline['chapters'] }[] = [];
    for (const chapter of outline.chapters) {
      const last = list[list.length - 1];
      if (last && last.actId === chapter.actId) last.chapters.push(chapter);
      else list.push({ actId: chapter.actId, name: chapter.actId ? names.get(chapter.actId) || t('manuscriptExport.untitledAct') : null, chapters: [chapter] });
    }
    return list;
  }, [outline, t]);
  const allSelected = !!outline && outline.chapters.every(chapter => selected.has(chapter.id));

  return (
    <ModalRoot onClose={onClose} ariaLabel={t('manuscriptExport.title')}
      closeOnBackdrop={!running} dismissOnEscape={!running} className="manuscript-export-root">
      <ModalCard width={520}>
        <ModalHeader title={t('manuscriptExport.title')} onClose={running ? undefined : onClose} closeLabel={t('common.close')} />
        <ModalBody className="manuscript-export">
          {!outline ? (
            loadError ? (
              <div className="manuscript-export__placeholder" role="alert">
                <p>{t('manuscriptExport.loadFailed')}</p>
                <Button onClick={() => { setLoadError(false); setAttempt(value => value + 1); }}>
                  <BrushIcon name="rotate" size={14} />{t('manuscriptExport.retry')}
                </Button>
              </div>
            ) : (
              <div className="manuscript-export__placeholder"><LoadingStatus label={t('manuscriptExport.loading')} /></div>
            )
          ) : (
            <>
              <section className="dialog-section">
                <span className="dialog-section__label">{t('manuscriptExport.format')}</span>
                <GlassSlider ariaLabel={t('manuscriptExport.format')} value={format}
                  onChange={(next) => { if (!running) setFormat(next); }}
                  options={MANUSCRIPT_FORMATS.map(value => ({ value, label: FORMAT_LABELS[value] }))} />
              </section>

              <section className="dialog-section">
                <span className="dialog-section__label">{t('manuscriptExport.scope')}</span>
                <GlassSlider ariaLabel={t('manuscriptExport.scope')} value={scope}
                  onChange={(next) => { if (!running) setScope(next); }}
                  options={[
                    { value: 'book' as const, label: t('manuscriptExport.wholeBook') },
                    { value: 'selected' as const, label: t('manuscriptExport.selectedChapters') },
                  ]} />
                <div className={`manuscript-export__chapters-shell${scope === 'selected' ? ' is-open' : ''}`}
                  aria-hidden={scope !== 'selected'}>
                  <div className="manuscript-export__chapters-clip">
                    <div className="manuscript-export__chapters-head">
                      <span>{t('manuscriptExport.chapterCount', { count: chapterIds.length })}</span>
                      <button type="button" className="manuscript-export__text-button" disabled={running || scope !== 'selected'}
                        onClick={() => setSelected(allSelected ? new Set() : new Set(outline.chapters.map(chapter => chapter.id)))}>
                        {allSelected ? t('manuscriptExport.selectNone') : t('manuscriptExport.selectAll')}
                      </button>
                    </div>
                    <div className="manuscript-export__chapters" role="group" aria-label={t('manuscriptExport.selectedChapters')}>
                      {groups.map((group, index) => (
                        <Fragment key={group.actId ?? `loose-${index}`}>
                          {group.name && <div className="manuscript-export__act">{group.name}</div>}
                          {group.chapters.map((chapter) => {
                            const on = selected.has(chapter.id);
                            return (
                              <button key={chapter.id} type="button" role="checkbox" aria-checked={on}
                                tabIndex={scope === 'selected' ? 0 : -1}
                                disabled={running}
                                className={`ui-toggle-row glass${on ? ' is-on' : ''}`}
                                style={{ '--toggle-color': 'hsl(var(--accent))' } as CSSProperties}
                                onClick={() => toggleChapter(chapter.id)}>
                                <KindMark kind="chapter" seed={chapter.id} />
                                <span className="ui-toggle-row__label">{chapter.title.trim() || t('manuscriptExport.untitledChapter')}</span>
                              </button>
                            );
                          })}
                        </Fragment>
                      ))}
                    </div>
                  </div>
                </div>
              </section>

              <section className="dialog-section">
                <span className="dialog-section__label">{t('manuscriptExport.contents')}</span>
                {hasActs && (
                  <label className="manuscript-export__switch">
                    <span>{t('manuscriptExport.actTitles')}</span>
                    <Switch size="sm" checked={actTitles} disabled={running} onCheckedChange={setActTitles}
                      aria-label={t('manuscriptExport.actTitles')} />
                  </label>
                )}
                <label className="manuscript-export__switch">
                  <span>{t('manuscriptExport.chapterTitles')}</span>
                  <Switch size="sm" checked={chapterTitles} disabled={running} onCheckedChange={setChapterTitles}
                    aria-label={t('manuscriptExport.chapterTitles')} />
                </label>
                <label className="manuscript-export__switch">
                  <span>{t('manuscriptExport.outlineHeadings')}</span>
                  <Switch size="sm" checked={outlineHeadings} disabled={running} onCheckedChange={setOutlineHeadings}
                    aria-label={t('manuscriptExport.outlineHeadings')} />
                </label>
              </section>

              <section className="dialog-section">
                <span className="dialog-section__label">{t('manuscriptExport.bookInfo')}</span>
                <div className="manuscript-export__field">
                  <span>{t('manuscriptExport.bookTitle')}</span>
                  <label className="ui-field glass glass--rest glass--field">
                    <input value={title} disabled={running} onChange={event => setTitle(event.target.value)}
                      aria-label={t('manuscriptExport.bookTitle')} />
                  </label>
                </div>
                <div className="manuscript-export__field">
                  <span>{t('manuscriptExport.author')}</span>
                  <label className="ui-field glass glass--rest glass--field">
                    <input value={author} disabled={running} onChange={event => setAuthor(event.target.value)}
                      aria-label={t('manuscriptExport.author')} />
                  </label>
                </div>
                <div className="manuscript-export__field">
                  <span>{t('manuscriptExport.cover')}</span>
                  <div className="manuscript-export__cover">
                    {cover && (
                      <img className="manuscript-export__cover-thumb" alt={t('manuscriptExport.cover')}
                        src={`data:${cover.mediaType};base64,${cover.data}`} />
                    )}
                    <Button onClick={() => void pickCover()} disabled={running}>
                      {busy === 'cover' ? <BrushIcon name="loader" size={14} className="ui-spin" /> : <BrushIcon name="image" size={14} />}
                      {cover ? t('manuscriptExport.changeCover') : t('manuscriptExport.chooseCover')}
                    </Button>
                    {cover && (
                      <Button variant="ghost" onClick={() => setCover(null)} disabled={running}>
                        {t('manuscriptExport.removeCover')}
                      </Button>
                    )}
                  </div>
                </div>
              </section>
            </>
          )}
        </ModalBody>
        <ModalActions>
          <span className="manuscript-export__feedback"
            role={feedback && feedback.kind !== 'saved' && busy !== 'export' ? 'alert' : 'status'}
            title={feedback?.detail}>
            {busy === 'export'
              ? t('manuscriptExport.exporting')
              : feedback && t(`manuscriptExport.${feedback.kind}`)}
          </span>
          <Button onClick={onClose} disabled={running}>{t('common.close')}</Button>
          <Button variant="primary" disabled={!canExport} onClick={() => void runExport()}>
            {busy === 'export' ? <BrushIcon name="loader" size={14} className="ui-spin" /> : <BrushIcon name="case-rise" size={14} />}
            {t('manuscriptExport.export', { format: FORMAT_LABELS[format] })}
          </Button>
        </ModalActions>
      </ModalCard>
    </ModalRoot>
  );
}
