import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';

import { HoverCardActions, type HoverActionGroup } from './HoverCard';
import { hoverCardSections } from './hover-card-sections';
import { entityHoverActions } from '../leftBars/entity-hover-actions';
import {
  withChapterStorylineChoices,
  withElementCategoryChoices,
  withElementGroupChoices,
} from '../../features/entities/hover/hover-choices';

const t = ((key: string) => key) as unknown as TFunction;

describe('hover card sections', () => {
  it('parts groups into sections, gives each cell with choices a section of its own and gathers danger last', () => {
    const groups: HoverActionGroup[] = [
      { key: 'status', label: 'Writing status', actions: [{ key: 'draft', label: 'Draft', active: true }, { key: 'done', label: 'Done' }] },
      {
        key: 'actions',
        actions: [
          { key: 'convert', label: 'Convert…' },
          { key: 'delete', label: 'Delete', danger: true },
          { key: 'move', label: 'Move to group…', choices: [{ key: 'root', label: 'Root' }] },
          { key: 'rename', label: 'Rename' },
        ],
      },
    ];

    expect(hoverCardSections(groups).map((section) => ({
      type: section.type,
      keys: section.type === 'folded' ? [section.action.key] : section.actions.map((action) => action.key),
    }))).toEqual([
      { type: 'fixed', keys: ['draft', 'done'] },
      { type: 'plain', keys: ['convert'] },
      { type: 'folded', keys: ['move'] },
      { type: 'plain', keys: ['rename'] },
      { type: 'plain', keys: ['delete'] },
    ]);
  });

  it('leads writing statuses with the menus\' marks and deleting with the wastebasket', () => {
    const [status, actions] = entityHoverActions({
      editorType: 'node',
      nodeStatusKind: 'chapter',
      nodeWritingStatus: 'draft',
      onAction: () => undefined,
      t,
    });
    expect(status!.label).toBe('editorTopBar.statusSection.chapter');
    expect(status!.actions.map((action) => action.icon)).toEqual([
      { brush: 'brush-lifted' },
      { brush: 'brush-laid' },
      { brush: 'brush-broken' },
    ]);
    expect(actions!.actions.find((action) => action.key === 'deleteNode')?.icon).toEqual({ brush: 'trash' });

    const [driftStatus, driftActions] = entityHoverActions({
      editorType: 'node',
      nodeStatusKind: 'drift',
      nodeWritingStatus: 'resting',
      onAction: () => undefined,
      t,
    });
    expect(driftStatus!.actions.map((action) => [action.icon, action.active])).toEqual([
      [{ brush: 'fluff' }, false],
      [{ brush: 'stone-sunk' }, true],
    ]);
    // A row that opens a dialog or a list takes no mark of its own.
    expect(driftActions!.actions.find((action) => action.key === 'convertDriftToChapter')?.icon).toBeUndefined();
  });

  it('unfolds a chapter\'s storylines as ticks it can toggle in place', () => {
    const onToggle = vi.fn();
    const groups = withChapterStorylineChoices(
      entityHoverActions({ editorType: 'node', nodeStatusKind: 'chapter', nodeWritingStatus: 'draft', onAction: () => undefined, t }),
      {
        memberIds: ['main'],
        storylines: [{ id: 'main', name: 'Main', color: '#5570A7' }, { id: 'quiet', name: 'Quiet', color: null }],
        onToggle,
      },
    );
    const edit = groups.flatMap((group) => group.actions).find((action) => action.key === 'editNodeStorylines')!;
    expect(edit.multiple).toBe(true);
    expect(edit.onSelect).toBeUndefined();
    expect(edit.icon).toBeUndefined();
    expect(edit.choices?.map(({ key, checked, icon, keepOpen }) => ({ key, checked, icon, keepOpen }))).toEqual([
      { key: 'main', checked: true, icon: { kind: 'storyline', color: '#5570A7' }, keepOpen: true },
      { key: 'quiet', checked: false, icon: { kind: 'storyline', color: undefined }, keepOpen: true },
    ]);
    edit.choices![1]!.onSelect!();
    expect(onToggle).toHaveBeenCalledWith('quiet');
  });

  it('unfolds an element\'s categories and groups, the current one in effect', () => {
    const onCategory = vi.fn();
    const onGroup = vi.fn();
    const onNewGroup = vi.fn();
    const base = entityHoverActions({ editorType: 'element', onAction: () => undefined, t });
    const groups = withElementGroupChoices(
      withElementCategoryChoices(base, {
        categoryId: 'people',
        categories: [{ id: 'people', name: 'People', color: '#B84A62' }, { id: 'places', name: 'Places' }],
        onMove: onCategory,
      }),
      { groupName: 'Allies', groupNames: ['Allies', 'Rivals'], onMove: onGroup, onNewGroup, t },
    );
    const actions = groups.flatMap((group) => group.actions);
    const category = actions.find((action) => action.key === 'categoryPicker')!;
    const group = actions.find((action) => action.key === 'groupPicker')!;

    expect(category.choices?.map(({ key, active, icon }) => ({ key, active, icon }))).toEqual([
      { key: 'people', active: true, icon: { kind: 'category', color: '#B84A62' } },
      { key: 'places', active: false, icon: { kind: 'category', color: undefined } },
    ]);
    expect(group.choices?.map(({ key, active, icon }) => ({ key, active, icon }))).toEqual([
      { key: 'group:Allies', active: true, icon: { brush: 'folder' } },
      { key: 'group:Rivals', active: false, icon: { brush: 'folder' } },
      { key: 'group:none', active: false, icon: { brush: 'folder-none' } },
      { key: 'group:new', active: undefined, icon: { brush: 'folder-plus' } },
    ]);
    group.choices![2]!.onSelect!();
    group.choices![3]!.onSelect!();
    expect(onGroup).toHaveBeenCalledWith(null);
    expect(onNewGroup).toHaveBeenCalled();
  });
});

describe('hover card rows as drawn', () => {
  it('draws one row per action, a fixed choice open, a folded list closed, ticks for several choices, danger last', () => {
    const markup = renderToStaticMarkup(createElement(HoverCardActions, {
      groups: [
        { key: 'status', label: 'Writing status', actions: [
          { key: 'draft', label: 'Draft', icon: { brush: 'brush-lifted' }, active: true },
          { key: 'done', label: 'Done', icon: { brush: 'brush-laid' } },
        ] },
        { key: 'actions', actions: [
          { key: 'delete', label: 'Delete', icon: { brush: 'trash' }, danger: true },
          { key: 'stories', label: 'Edit storylines', multiple: true, choices: [
            { key: 'main', label: 'Main', icon: { kind: 'storyline', color: '#5570A7' }, checked: true },
          ] },
        ] },
      ],
    }));

    expect(markup.match(/class="hover-card__section(?: is-open)?"/g)).toEqual([
      'class="hover-card__section"',
      'class="hover-card__section"',
      'class="hover-card__section"',
    ]);
    // The fixed choice: its header, then its rows, the one in effect ringed.
    expect(markup).toContain('<div class="hover-card__section-label">Writing status</div>');
    expect(markup).toContain('class="hover-card__row is-active"');
    expect(markup).toContain('aria-pressed="true"');
    // The folded list: a header that opens it, its rows out of the tab order until it does.
    expect(markup).toContain('class="hover-card__section-head" aria-expanded="false"');
    expect(markup).toMatch(/class="hover-card__row is-checked"[^>]*tabindex="-1"/);
    expect(markup).toContain('hover-card__tick');
    // Danger comes last, after the folded list, though it was listed first.
    expect(markup.indexOf('hover-card__row--danger')).toBeGreaterThan(markup.indexOf('hover-card__section-head'));
  });
});
