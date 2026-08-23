import { useCallback, useMemo, useRef } from 'react';
import {
  ArrowLeft,
  BookOpenText,
  Boxes,
  FolderTree,
  GitBranch,
  Lightbulb,
  LoaderCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import loglevel from 'loglevel';

import { ROOT_GROUP_KEY, buildDriftGroupChildren } from '../../../domain/drift-group';
import { useProjectNavigation } from '../../../hooks/useProjectNavigation';
import { useAuthStore } from '../../../store/auth';
import { useDataStore } from '../../../store/data-store';
import {
  useUiStore,
  type CreateTab,
  type UniversalCreateEntityKind,
} from '../../../store/ui-store';
import { useBookElement } from '../../../usecase/useBookElement';
import { useBookNode } from '../../../usecase/useBookNode';
import { useElementCategory } from '../../../usecase/useElementCategory';
import { useStoryline } from '../../../usecase/useStoryline';
import {
  createUniversalEntity,
  createUniversalSubmissionGate,
} from './desktop-universal-create';
import '../../../../styles/desktop-universal-create.css';

const log = loglevel.getLogger('DesktopUniversalCreateView');

interface DesktopUniversalCreateViewProps {
  tab: CreateTab;
}

const KIND_ICONS = {
  chapter: BookOpenText,
  drift: Lightbulb,
  element: Boxes,
  storyline: GitBranch,
  category: FolderTree,
} as const;

const KIND_ORDER: UniversalCreateEntityKind[] = [
  'chapter',
  'drift',
  'element',
  'storyline',
  'category',
];

export function DesktopUniversalCreateView({ tab }: DesktopUniversalCreateViewProps) {
  const { t } = useTranslation();
  const { projectId, activateLeafTab } = useProjectNavigation();
  const userId = useAuthStore((state) => state.user?.id) ?? '';
  const bookNodes = useDataStore((state) => state.bookNodes);
  const storylines = useDataStore((state) => state.storylines);
  const driftGroups = useDataStore((state) => state.driftGroups);
  const bookElements = useDataStore((state) => state.bookElements);
  const categories = useDataStore((state) => state.bookElementCategories);
  const updateDraft = useUiStore((state) => state.updateCreateTabDraft);
  const replaceCreateTab = useUiStore((state) => state.replaceCreateTabWithEntity);
  const submissionGateRef = useRef(createUniversalSubmissionGate());

  const { createNode } = useBookNode({ projectId: projectId ?? '', userId });
  const { createStoryline } = useStoryline({ projectId: projectId ?? '', userId });
  const { createElement } = useBookElement({ projectId: projectId ?? '', userId });
  const { createCategory } = useElementCategory({ projectId: projectId ?? '', userId });

  const sortedStorylines = useMemo(
    () => [...storylines].sort((a, b) => a.orderKey - b.orderKey),
    [storylines],
  );
  const sortedCategories = useMemo(
    () => [...categories].sort((a, b) => a.name.localeCompare(b.name)),
    [categories],
  );
  const flatDriftGroups = useMemo(() => {
    const children = buildDriftGroupChildren(driftGroups);
    const result: Array<{ id: string; name: string; depth: number }> = [];
    const walk = (parentId: string, depth: number) => {
      for (const group of children.get(parentId) ?? []) {
        result.push({ id: group.id, name: group.name, depth });
        walk(group.id, depth + 1);
      }
    };
    walk(ROOT_GROUP_KEY, 0);
    return result;
  }, [driftGroups]);
  const elementGroups = useMemo(() => {
    if (!tab.draft.categoryId) return [];
    return Array.from(
      new Set(
        bookElements
          .filter((element) => element.categoryId === tab.draft.categoryId)
          .map((element) => element.groupName?.trim())
          .filter((name): name is string => Boolean(name)),
      ),
    ).sort((a, b) => a.localeCompare(b));
  }, [bookElements, tab.draft.categoryId]);

  const patchDraft = useCallback(
    (patch: Parameters<typeof updateDraft>[1]) => {
      if (!projectId) return;
      updateDraft(projectId, patch);
    },
    [projectId, updateDraft],
  );

  const commit = useCallback(
    async (kind: UniversalCreateEntityKind) => {
      if (!projectId || tab.draft.status === 'creating') return;
      if (kind === 'element' && !tab.draft.categoryId) return;
      try {
        await submissionGateRef.current.run(async () => {
          patchDraft({ entityKind: kind, status: 'creating', error: null });
          const target = await createUniversalEntity({
            kind,
            projectId,
            draft: tab.draft,
            bookNodes,
            services: { createNode, createStoryline, createElement, createCategory },
          });
          const result = replaceCreateTab(projectId, target);
          if (result.wasActive) activateLeafTab(target);
        });
      } catch (error) {
        log.error('Universal create failed', error);
        patchDraft({
          status: 'idle',
          error: error instanceof Error ? error.message : t('universalCreate.errorUnknown'),
        });
      }
    },
    [
      activateLeafTab,
      bookNodes,
      createCategory,
      createElement,
      createNode,
      createStoryline,
      patchDraft,
      projectId,
      replaceCreateTab,
      t,
      tab.draft,
    ],
  );

  const selectKind = (kind: UniversalCreateEntityKind) => {
    if (tab.draft.status === 'creating') return;
    if (kind === 'storyline' || kind === 'category') {
      void commit(kind);
      return;
    }
    patchDraft({
      step: 'context',
      entityKind: kind,
      storylineId: null,
      driftGroupId: null,
      categoryId: null,
      elementGroupName: null,
      error: null,
    });
  };

  const selectedKind = tab.draft.entityKind;
  const isCreating = tab.draft.status === 'creating';
  const canSubmit =
    selectedKind !== null &&
    selectedKind !== 'storyline' &&
    selectedKind !== 'category' &&
    (selectedKind !== 'element' || Boolean(tab.draft.categoryId)) &&
    !isCreating;

  return (
    <main className="universal-create" aria-labelledby="universal-create-title">
      <div className="universal-create__content">
        {tab.draft.step === 'context' && (
          <button
            type="button"
            className="universal-create__back"
            disabled={isCreating}
            onClick={() =>
              patchDraft({
                step: 'kind',
                entityKind: null,
                storylineId: null,
                driftGroupId: null,
                categoryId: null,
                elementGroupName: null,
                error: null,
              })
            }
          >
            <ArrowLeft size={15} aria-hidden />
            {t('universalCreate.back')}
          </button>
        )}

        <header className="universal-create__header">
          <p className="universal-create__eyebrow">{t('universalCreate.eyebrow')}</p>
          <h1 id="universal-create-title">
            {tab.draft.step === 'kind'
              ? t('universalCreate.title')
              : t(`universalCreate.contextTitle.${selectedKind}`)}
          </h1>
          <p>
            {tab.draft.step === 'kind'
              ? t('universalCreate.subtitle')
              : t(`universalCreate.contextSubtitle.${selectedKind}`)}
          </p>
        </header>

        {tab.draft.step === 'kind' ? (
          <div className="universal-create__kinds">
            {KIND_ORDER.map((kind) => {
              const Icon = KIND_ICONS[kind];
              const commitsImmediately = kind === 'storyline' || kind === 'category';
              return (
                <button
                  key={kind}
                  type="button"
                  className="universal-create__kind"
                  disabled={isCreating}
                  onClick={() => selectKind(kind)}
                >
                  <Icon size={19} strokeWidth={1.6} aria-hidden />
                  <span className="universal-create__kind-copy">
                    <strong>{t(`universalCreate.kinds.${kind}.label`)}</strong>
                    <span>{t(`universalCreate.kinds.${kind}.description`)}</span>
                  </span>
                  {isCreating && tab.draft.entityKind === kind ? (
                    <LoaderCircle className="universal-create__spinner" size={16} aria-hidden />
                  ) : (
                    <span className="universal-create__kind-action">
                      {t(
                        commitsImmediately
                          ? 'universalCreate.createNow'
                          : 'universalCreate.continue',
                      )}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          <section className="universal-create__context">
            {selectedKind === 'chapter' && (
              <label className="universal-create__field">
                <span>{t('universalCreate.fields.storyline')}</span>
                <select
                  value={tab.draft.storylineId ?? ''}
                  disabled={isCreating}
                  onChange={(event) =>
                    patchDraft({ storylineId: event.target.value || null, error: null })
                  }
                >
                  <option value="">{t('universalCreate.defaults.unaffiliated')}</option>
                  {sortedStorylines.map((storyline) => (
                    <option key={storyline.id} value={storyline.id}>
                      {storyline.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {selectedKind === 'drift' && (
              <label className="universal-create__field">
                <span>{t('universalCreate.fields.driftGroup')}</span>
                <select
                  value={tab.draft.driftGroupId ?? ''}
                  disabled={isCreating}
                  onChange={(event) =>
                    patchDraft({ driftGroupId: event.target.value || null, error: null })
                  }
                >
                  <option value="">{t('universalCreate.defaults.root')}</option>
                  {flatDriftGroups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {`${'— '.repeat(group.depth)}${group.name}`}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {selectedKind === 'element' && (
              <>
                <label className="universal-create__field">
                  <span>{t('universalCreate.fields.categoryRequired')}</span>
                  <select
                    value={tab.draft.categoryId ?? ''}
                    disabled={isCreating || sortedCategories.length === 0}
                    onChange={(event) =>
                      patchDraft({
                        categoryId: event.target.value || null,
                        elementGroupName: null,
                        error: null,
                      })
                    }
                  >
                    <option value="">{t('universalCreate.defaults.chooseCategory')}</option>
                    {sortedCategories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="universal-create__field">
                  <span>{t('universalCreate.fields.elementGroup')}</span>
                  <select
                    value={tab.draft.elementGroupName ?? ''}
                    disabled={isCreating || !tab.draft.categoryId}
                    onChange={(event) =>
                      patchDraft({ elementGroupName: event.target.value || null, error: null })
                    }
                  >
                    <option value="">{t('universalCreate.defaults.ungrouped')}</option>
                    {elementGroups.map((groupName) => (
                      <option key={groupName} value={groupName}>
                        {groupName}
                      </option>
                    ))}
                  </select>
                </label>
                {sortedCategories.length === 0 && (
                  <p className="universal-create__notice">
                    {t('universalCreate.noCategories')}
                  </p>
                )}
              </>
            )}

            {tab.draft.error && (
              <p className="universal-create__error" role="alert">
                {tab.draft.error}
              </p>
            )}

            <button
              type="button"
              className="universal-create__submit"
              disabled={!canSubmit}
              onClick={() => selectedKind && void commit(selectedKind)}
            >
              {isCreating && <LoaderCircle className="universal-create__spinner" size={16} />}
              {isCreating ? t('universalCreate.creating') : t('universalCreate.submit')}
            </button>
          </section>
        )}

        {tab.draft.step === 'kind' && tab.draft.error && (
          <p className="universal-create__error" role="alert">
            {tab.draft.error}
          </p>
        )}
      </div>
    </main>
  );
}
