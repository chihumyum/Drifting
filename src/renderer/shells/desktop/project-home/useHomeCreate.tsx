import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import loglevel from 'loglevel';

import type { BrushIconName } from '../../../components/ui/BrushIcon';
import type { KindMarkKind } from '../../../components/ui/kind-mark';
import { useEditorSurfaceLifecycle } from '../../../components/editor/editor-surface-lifecycle-context';
import { ROOT_GROUP_KEY, buildDriftGroupChildren } from '../../../domain/drift-group';
import { useProjectNavigation } from '../../../hooks/useProjectNavigation';
import { useAuthStore } from '../../../store/auth';
import { useDataStore } from '../../../store/data-store';
import { useUiStore } from '../../../store/ui-store';
import { useBookElement } from '../../../usecase/useBookElement';
import { useBookNode } from '../../../usecase/useBookNode';
import { useElementCategory } from '../../../usecase/useElementCategory';
import { useEntityRelations } from '../../../usecase/useEntityRelations';
import { useLibraryItem } from '../../../usecase/useLibraryItem';
import { useStoryline } from '../../../usecase/useStoryline';
import { requestChapterTitleFocus } from '../../../features/editor/chapter-title-focus';
import { ComposeLibraryItemDialog } from '../../../features/library/LibraryDialogs';
import type { WorkspaceTarget } from '../../../features/workspace/navigation/workspace-target';
import {
  HOME_CREATE_KINDS,
  createHomeEntity,
  createSubmissionGate,
  type HomeCreateKind,
  type HomeCreatePlace,
} from './home-create';

const log = loglevel.getLogger('HomeCreate');

/** The kind the dock's + puts the focus on: the one used last this session. */
let lastUsedKind: HomeCreateKind = 'chapter';
export function lastHomeCreateKind(): HomeCreateKind {
  return lastUsedKind;
}

export interface HomeCreatePick {
  key: string;
  label: string;
  mark?: { kind: KindMarkKind; color?: string; hollow?: boolean };
  icon?: BrushIconName;
  /** The glass takes this colour (a storyline's or a category's). */
  color?: string;
  accent?: boolean;
  run: () => void;
}

export interface HomeCreateEntry {
  kind: HomeCreateKind;
  label: string;
  /** Null: nothing to choose, a click creates. */
  picks: HomeCreatePick[] | null;
  picksLabel: string;
  create: () => void;
}

export interface HomeCreateModel {
  entries: HomeCreateEntry[];
  busyKey: string | null;
  error: string | null;
  openKind: HomeCreateKind | null;
  setOpenKind: (kind: HomeCreateKind | null) => void;
  /**
   * The focus Home places on arrival is quiet: it opens no places until the
   * author moves it with the keyboard, points into the row or leaves it.
   */
  quiet: boolean;
  hush: () => void;
  wake: () => void;
  /** The material dialog for 图片… / PDF…, rendered by the page. */
  dialog: ReactNode;
}

/**
 * Project Home's create row. Nothing is named first: each kind is one
 * control. A kind that needs a place (a chapter's storyline, a drift's
 * group, an element's category, a material's type) shows those places as
 * small pills straight above it while the pointer or the focus is on it, and
 * picking one creates; a kind with nothing to choose creates on click. The
 * new thing opens pinned with its default name; chapters and drifts select
 * the title so typing renames them.
 */
export function useHomeCreate(): HomeCreateModel {
  const { t } = useTranslation();
  const { projectId, openEntity } = useProjectNavigation();
  const { isVisible } = useEditorSurfaceLifecycle();
  const visibleRef = useRef(isVisible);
  useEffect(() => {
    visibleRef.current = isVisible;
  }, [isVisible]);
  const userId = useAuthStore((state) => state.user?.id) ?? '';
  const context = { projectId: projectId ?? '', userId };
  const { createNode } = useBookNode(context);
  const { createStoryline } = useStoryline(context);
  const { createElement } = useBookElement(context);
  const { createCategory } = useElementCategory(context);
  const libraryItems = useLibraryItem(context);
  const relations = useEntityRelations(context);
  const storylines = useDataStore((state) => state.storylines);
  const driftGroups = useDataStore((state) => state.driftGroups);
  const categories = useDataStore((state) => state.bookElementCategories);
  const [gate] = useState(createSubmissionGate);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openKind, setOpenKind] = useState<HomeCreateKind | null>(null);
  const [quiet, setQuiet] = useState(false);
  const hush = useCallback(() => setQuiet(true), []);
  const wake = useCallback(() => setQuiet(false), []);
  const [materialKind, setMaterialKind] = useState<'image' | 'pdf' | null>(null);

  /** Open what was made, unless the author has already left Home. */
  const reveal = useCallback(
    (target: WorkspaceTarget, kind: HomeCreateKind) => {
      if (target.entityType === 'node') requestChapterTitleFocus(target.id);
      if (!projectId) return;
      if (visibleRef.current) openEntity(target, { preview: false });
      else useUiStore.getState().openEntityTab(projectId, target, { preview: false, activate: false });
      lastUsedKind = kind;
    },
    [openEntity, projectId],
  );

  const run = useCallback(
    async (key: string, kind: HomeCreateKind, place: HomeCreatePlace) => {
      if (!projectId) return;
      try {
        await gate.run(async () => {
          setBusyKey(key);
          setError(null);
          try {
            const target = await createHomeEntity({
              kind,
              projectId,
              place,
              bookNodes: useDataStore.getState().bookNodes,
              names: {
                chapter: t('chapterEnd.defaultTitle'),
                drift: t('leftSidebar.actions.newDrift'),
                storyline: t('projectHome.create.defaults.storyline'),
                material: t('common.untitled'),
              },
              services: {
                createNode,
                createStoryline,
                createElement,
                createCategory,
                createTextMaterial: (title) =>
                  libraryItems.createLibraryItem({ kind: 'text', title, bodyJson: null, folderId: null }),
              },
            });
            setOpenKind(null);
            reveal(target, kind);
          } finally {
            setBusyKey(null);
          }
        });
      } catch (cause) {
        log.error('Project Home create failed', cause);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [createCategory, createElement, createNode, createStoryline, gate, libraryItems, projectId, reveal, t],
  );

  const entries = useMemo<HomeCreateEntry[]>(() => {
    const sortedStorylines = [...storylines].sort((a, b) => a.orderKey - b.orderKey);
    const sortedCategories = [...categories].sort((a, b) => a.name.localeCompare(b.name));
    const children = buildDriftGroupChildren(driftGroups);
    const groups: Array<{ id: string; name: string }> = [];
    const walk = (parentId: string) => {
      for (const group of children.get(parentId) ?? []) {
        groups.push({ id: group.id, name: group.name });
        walk(group.id);
      }
    };
    walk(ROOT_GROUP_KEY);

    const picksFor = (kind: HomeCreateKind): HomeCreatePick[] | null => {
      const pick = (key: string, place: HomeCreatePlace, rest: Omit<HomeCreatePick, 'key' | 'run'>) => ({
        key: `${kind}:${key}`,
        ...rest,
        run: () => void run(`${kind}:${key}`, kind, place),
      });
      switch (kind) {
        case 'chapter':
          if (sortedStorylines.length === 0) return null;
          return [
            pick('none', { storylineId: null }, {
              label: t('projectHome.create.picks.unaffiliated'),
              mark: { kind: 'storyline', hollow: true },
            }),
            ...sortedStorylines.map((storyline) => {
              const color = storyline.color || 'hsl(var(--ink-4))';
              return pick(storyline.id, { storylineId: storyline.id }, {
                label: storyline.name,
                mark: { kind: 'storyline', color },
                color,
              });
            }),
          ];
        case 'drift':
          if (groups.length === 0) return null;
          return [
            pick('root', { driftGroupId: null }, {
              label: t('projectHome.create.picks.root'),
              mark: { kind: 'drift' },
            }),
            ...groups.map((group) =>
              pick(group.id, { driftGroupId: group.id }, { label: group.name, mark: { kind: 'drift' } }),
            ),
          ];
        case 'element':
          if (sortedCategories.length === 0) {
            return [{
              key: 'element:new-category',
              label: t('projectHome.create.picks.newCategory'),
              icon: 'plus',
              accent: true,
              run: () => void run('element:new-category', 'category', {}),
            }];
          }
          return sortedCategories.map((category) => {
            const color = category.color?.trim() || 'hsl(var(--ink-4))';
            return pick(category.id, { categoryId: category.id }, {
              label: category.name,
              mark: { kind: 'category', color },
              color,
            });
          });
        case 'material':
          return [
            pick('text', {}, { label: t('projectHome.create.picks.text'), icon: 'file-text' }),
            {
              key: 'material:image',
              label: t('projectHome.create.picks.image'),
              icon: 'image',
              run: () => setMaterialKind('image'),
            },
            {
              key: 'material:pdf',
              label: t('projectHome.create.picks.pdf'),
              icon: 'file-text',
              run: () => setMaterialKind('pdf'),
            },
          ];
        default:
          return null;
      }
    };

    return HOME_CREATE_KINDS.map((kind) => ({
      kind,
      label: t(`projectHome.create.kinds.${kind}`),
      picks: picksFor(kind),
      picksLabel: t(`projectHome.create.picksLabel.${kind}`, { defaultValue: '' }),
      create: () => void run(kind, kind, {}),
    }));
  }, [categories, driftGroups, run, storylines, t]);

  const dialog = materialKind ? (
    <ComposeLibraryItemDialog
      focused={{ kind: null, id: null }}
      initialKind={materialKind}
      onCancel={() => setMaterialKind(null)}
      onCreate={async (input, links) => {
        const material = await libraryItems.createLibraryItem({ ...input, folderId: null });
        await Promise.allSettled(
          links.map((target) =>
            relations.addGenericAssociation('library_item', material.id, target.kind, target.id),
          ),
        );
        reveal({ entityType: 'library_item', id: material.id }, 'material');
      }}
    />
  ) : null;

  return { entries, busyKey, error, openKind, setOpenKind, quiet, hush, wake, dialog };
}
