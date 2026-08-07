import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function block(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Missing block: ${start} -> ${end}`);
  return text.slice(from, to);
}

describe('ElementPanel compact text index', () => {
  it('persists an explicit compact/list choice and migrates the retired visual value', () => {
    const store = source('src/renderer/store/ui-store.ts');
    const subheader = source('src/renderer/components/leftBars/LeftSidebarSubHeader.tsx');
    const en = JSON.parse(source('src/renderer/locales/en.json'));
    const zh = JSON.parse(source('src/renderer/locales/zh-CN.json'));

    expect(store).toContain("export type ElementPanelViewMode = 'compact' | 'list'");
    expect(store).toContain("elementPanelViewMode: 'compact'");
    expect(store).toContain('elementPanelViewMode: state.elementPanelViewMode');
    expect(store).toContain("(merged.elementPanelViewMode as string) === 'visual'");
    expect(subheader).toContain("{ value: 'compact', label: t('leftSidebar.sort.compactIndex') }");
    expect(subheader).toContain("{ value: 'list', label: t('leftSidebar.sort.nameList') }");
    expect(subheader).toContain("title: t('leftSidebar.sort.elementDisplayGroup')");
    expect(en.leftSidebar.sort.compactIndex).toBe('Compact index');
    expect(zh.leftSidebar.sort.compactIndex).toBe('紧凑索引');
  });

  it('renders complete names in a content-shaped wrapping flex flow with no portrait path', () => {
    const panel = source('src/renderer/components/leftBars/ElementPanel.tsx');
    const tile = source('src/renderer/components/ui/ElementIdentityTile.tsx');
    const css = source('src/styles/ui-controls.css');
    const flow = block(css, '.element-identity-flow {', '.element-identity-flow--grouped {');
    const labelTypography = block(css, '.element-panel-item-label {', '.element-identity-tile {');
    const tileRule = block(css, '.element-identity-tile {', '.element-identity-tile:hover {');
    const compactLabel = block(
      css,
      '.element-identity-tile__label {',
      '.element-identity-tile__agent {',
    );

    expect(panel).toContain("const compactIndex = viewMode === 'compact'");
    expect(panel).toContain('<ElementIdentityTile');
    expect(panel).toContain('element-identity-flow');
    expect(panel).not.toContain('projectAssets');
    expect(panel).not.toContain('portraitAssetId');
    expect(tile).toContain("const label = element.name.trim() || '?';");
    expect(tile).toContain('workspace-list-row element-identity-tile');
    expect(tile).toContain(
      '<span className="element-panel-item-label element-identity-tile__label">{label}</span>',
    );
    expect(panel).toContain(
      "className={`element-panel-item-label${selected ? ' is-selected' : ''}`}",
    );
    expect(tile).toContain('Math.min(156, Math.max(70, 34 + units * 8))');
    expect(tile).not.toContain('<img');
    expect(tile).not.toContain('IntersectionObserver');
    expect(flow).toContain('display: flex;');
    expect(flow).toContain('flex-wrap: wrap;');
    expect(tileRule).toContain('flex: 1 1 var(--element-identity-basis);');
    expect(tileRule).toContain('min-height: 30px;');
    expect(tileRule).not.toContain('44px');
    expect(labelTypography).toContain('font-family: var(--font-sans);');
    expect(labelTypography).toContain('font-size: 12.5px;');
    expect(labelTypography).toContain('font-weight: 400;');
    expect(labelTypography).toContain('line-height: 1.35;');
    expect(labelTypography).toContain('letter-spacing: -0.005em;');
    expect(labelTypography).toContain(
      '.element-identity-tile.is-selected .element-panel-item-label',
    );
    expect(compactLabel).not.toContain('font-size:');
    expect(compactLabel).not.toContain('font-weight:');
    expect(compactLabel).not.toContain('line-height:');
  });

  it('uses one minus/square disclosure while the category label opens its editor', () => {
    const panel = source('src/renderer/components/leftBars/ElementPanel.tsx');
    const header = source('src/renderer/components/leftBars/GroupHeaderCell.tsx');
    const css = source('src/styles/ui-controls.css');
    const categoryBody = block(
      css,
      '.element-category-section--compact {',
      '.element-identity-flow {',
    );
    const frameDisclosure = block(
      header,
      "{collapseChrome === 'frame' && (",
      '{!agentBusy && (agentSelfAdded || agentSelfChanged)',
    );
    const frameLabel = block(
      header,
      'className="left-sb-group-header__frame-label"',
      '</button>\n        ) : (',
    );

    expect(categoryBody).toContain('background: transparent;');
    expect(categoryBody).toContain('.element-category-section--compact::before {');
    expect(categoryBody).toContain('inset: 13px 0 0;');
    expect(categoryBody).toContain('border: 1px solid var(--element-category-color);');
    expect(categoryBody).toContain('border-top: 0;');
    expect(categoryBody).toContain('.left-sb-group-header--frame.is-expanded::before {');
    expect(categoryBody).toContain('background: var(--element-category-color);');
    expect(categoryBody).toContain('.left-sb-group-header--frame.is-expanded::after {');
    expect(categoryBody).toContain('border-right: 1px solid var(--element-category-color);');
    expect(categoryBody).toContain('border-left: 1px solid var(--element-category-color);');
    expect(categoryBody).toContain('.element-category-section--compact.is-collapsed {');
    expect(categoryBody).toContain('.element-category-section--compact.is-collapsed::before {');
    expect(categoryBody).toContain('opacity: 0;');
    expect(panel).toContain("collapseChrome={compactIndex ? 'frame' : 'chevron'}");
    expect(panel).toContain("'--element-category-color': categoryColor");
    expect(panel).toContain('const categoryHasElements = categoryElements.length > 0;');
    expect(panel).toContain('!categoryHasElements || collapsedCategoryIds.has(categoryId)');
    expect(panel).toContain('collapseDisabled={compactIndex && !categoryHasElements}');
    expect(panel).toContain("addButtonVisibility={compactIndex ? 'always' : 'hover'}");
    expect(panel).not.toContain('stickyBackground=');
    expect(header).toContain("const showRestingColorMarker = collapseChrome === 'chevron'");
    expect(header).toContain("collapseChrome === 'chevron' &&");
    expect(header).toContain("collapseChrome === 'frame' ?");
    expect(frameDisclosure).toContain('className="left-sb-group-header__frame-disclosure"');
    expect(frameDisclosure).toContain('disabled={collapseDisabled}');
    expect(frameDisclosure).toContain('aria-expanded={!collapsed}');
    expect(frameDisclosure).toContain("color: collapsed ? color : 'hsl(var(--ink-4))'");
    expect(frameDisclosure).toContain('onToggleCollapsed();');
    expect(frameDisclosure).toContain('left-sb-group-header__frame-color-square');
    expect(frameDisclosure).toContain('<Minus size={11} strokeWidth={1.8} />');
    expect(header).toContain('className="left-sb-group-header__frame-label"');
    expect(frameLabel).toContain('aria-disabled={!onClick}');
    expect(frameLabel).toContain('onClick?.();');
    expect(frameLabel).not.toContain('onToggleCollapsed');
    expect(frameLabel).not.toContain('aria-expanded');
    expect(panel).not.toContain('isUncategorized || compactIndex');
    expect(panel).toContain("openEntity({ entityType: 'category', id: categoryId })");
    expect(header).toContain('showRestingColorMarker || agentBusy');
  });

  it('reuses the borderless material-card surface and keeps selection as highlight only', () => {
    const tile = source('src/renderer/components/ui/ElementIdentityTile.tsx');
    const css = source('src/styles/ui-controls.css');
    const sharedCard = block(css, '.workspace-list-row {', '.label-mono {');
    const tileRule = block(css, '.element-identity-tile {', '.element-identity-tile:hover {');
    const selectedRule = block(
      css,
      '.element-identity-tile.is-selected {',
      '.element-identity-tile:focus-visible {',
    );

    expect(tile).toContain('workspace-list-row element-identity-tile');
    expect(sharedCard).toContain('border: 0;');
    expect(sharedCard).not.toContain('workspace-card-border');
    expect(sharedCard).toContain(
      'background: color-mix(in srgb, hsl(var(--page)) 55%, var(--workspace-ui-bg));',
    );
    expect(sharedCard).toContain('background: var(--workspace-cell-hover-bg);');
    expect(tileRule).not.toContain('background:');
    expect(tileRule).not.toContain('border:');
    expect(selectedRule).not.toContain('border');
    expect(selectedRule).toContain('background: hsl(var(--surface));');
    expect(selectedRule).toContain('box-shadow: none;');
  });

  it('keeps only the final-group/ungrouped gap and scopes group-add hover to its label', () => {
    const panel = source('src/renderer/components/leftBars/ElementPanel.tsx');
    const css = source('src/styles/ui-controls.css');
    const groupedFlow = block(css, '.element-identity-flow--grouped {', '.element-identity-tile {');
    const groupHeader = panel.slice(panel.indexOf('function ElementGroupHeader('));
    const groupAddButton = block(css, '.left-sb-group-add {', '/* Element compact text index');

    expect(panel).toContain('const isNamedGroup = groupName !== null;');
    expect(panel).toContain("isNamedGroup ? ' element-identity-flow--grouped' : ''");
    expect(groupedFlow).toContain('border: 1px solid hsl(var(--rule) / 0.55);');
    expect(groupedFlow).toContain('pointer-events: none;');
    expect(groupedFlow).not.toContain('background:');
    expect(groupedFlow).not.toContain('margin-bottom');
    expect(groupedFlow).toContain(
      '.element-category-group--last-named + .element-category-group--ungrouped {',
    );
    expect(groupedFlow).toContain('margin-top: 3px;');
    expect(panel).toContain('groupIndex === lastNamedGroupIndex');
    expect(panel).toContain("' element-category-group--ungrouped'");
    expect(groupHeader).toContain('className="left-sb-inline-group-header"');
    expect(groupHeader).toContain('className="left-sb-group-add left-sb-inline-add-button"');
    expect(groupHeader).not.toContain('onMouseEnter');
    expect(groupHeader).not.toContain('opacity: hovered');
    expect(groupHeader).not.toContain('e.currentTarget.style.background');
    expect(groupAddButton).toContain('.left-sb-inline-group-header:hover .left-sb-group-add,');
    expect(groupAddButton).toContain('pointer-events: none;');
    expect(groupAddButton).toContain('background: transparent;');
    expect(groupAddButton).toContain('background: hsl(var(--paper-deep));');
  });

  it('places category, chapter, and drift creation actions directly after their labels', () => {
    const panel = source('src/renderer/components/leftBars/ElementPanel.tsx');
    const chapter = source('src/renderer/components/leftBars/ChapterPanel.tsx');
    const drift = source('src/renderer/components/leftBars/DriftPanel.tsx');
    const header = source('src/renderer/components/leftBars/GroupHeaderCell.tsx');
    const css = source('src/styles/ui-controls.css');
    const groupAddButton = block(css, '.left-sb-group-add {', '/* Element compact text index');

    expect(header).toContain('<span className="left-sb-inline-actions">');
    expect(header).toContain("justifyContent: 'flex-start'");
    expect(header).toContain("addButtonVisibility === 'always'");
    expect(header).toContain('left-sb-group-add--always');
    expect(panel).toContain("addButtonVisibility={compactIndex ? 'always' : 'hover'}");
    expect(panel).toContain("t('elementCategoryCreateMenu.openCreateMenu')");
    expect(chapter).toContain("addButtonTitle={t('leftSidebar.groups.newChapterInStoryline')}");
    expect(chapter).toContain("addButtonTitle={t('leftSidebar.actions.newChapter')}");
    expect(drift).toContain("addButtonTitle={t('leftSidebar.groups.newDriftInGroup')}");
    expect(drift).toContain('className="left-sb-inline-group-header"');
    expect(groupAddButton).toContain('.left-sb-group-add--always,');
    expect(groupAddButton).toContain('.left-sb-group-header:hover .left-sb-group-add,');
  });

  it('uses the category plus as one anchored element/group creation menu', () => {
    const panel = source('src/renderer/components/leftBars/ElementPanel.tsx');
    const header = source('src/renderer/components/leftBars/GroupHeaderCell.tsx');
    const menu = source('src/renderer/components/leftBars/ElementCategoryCreateMenu.tsx');
    const docs = source('docs/design-system.md');
    const en = JSON.parse(source('src/renderer/locales/en.json'));
    const zh = JSON.parse(source('src/renderer/locales/zh-CN.json'));

    expect(header).toContain('onAdd?: (event: MouseEvent<HTMLButtonElement>) => void;');
    expect(header).toContain('aria-haspopup={addButtonHasPopup}');
    expect(header).toContain('aria-expanded={addButtonHasPopup ? addButtonExpanded : undefined}');
    expect(header).toContain("addButtonExpanded ? ' left-sb-group-add--expanded' : ''");
    expect(header).toContain('onAdd(event);');
    expect(panel).toContain('const categoryCreateAnchorRef = useRef<HTMLButtonElement>(null);');
    expect(panel).toContain('categoryCreateAnchorRef.current = event.currentTarget;');
    expect(panel).toContain("addButtonHasPopup={isUncategorized ? undefined : 'menu'}");
    expect(panel).toContain('addButtonExpanded={categoryCreateCategoryId === categoryId}');
    expect(panel).toContain('<ElementCategoryCreateMenu');
    expect(panel).toContain('handleCreateElement(categoryCreateCategoryId)');
    expect(panel).toContain('handleCreateElementInGroup(categoryCreateCategoryId, groupName)');
    expect(menu).toContain('<AnchoredPopover');
    expect(menu).toContain("role={mode === 'actions' ? 'menu' : 'dialog'}");
    expect(menu).toContain("setMode('group')");
    expect(menu).toContain('existingGroupNames.some(');
    expect(menu).toContain('onCreateGroup(groupName);');
    expect(menu).toContain("'elementCategoryCreateMenu.groupCreatesFirstElement'");
    expect(source('src/styles/ui-controls.css')).toContain('.left-sb-group-add--expanded {');
    expect(zh.elementCategoryCreateMenu.newElement).toBe('新建元素');
    expect(zh.elementCategoryCreateMenu.newGroup).toBe('新建分组…');
    expect(en.elementCategoryCreateMenu.newElement).toBe('New element');
    expect(en.elementCategoryCreateMenu.newGroup).toBe('New group…');
    expect(docs).toContain('锚定菜单');
    expect(docs).toContain('同时创建、打开首个 element');
  });

  it('keeps the shared hover/focus preview as secondary element context', () => {
    const model = source('src/renderer/features/entities/hover/entity-hover-card-model.ts');
    const card = source('src/renderer/features/entities/hover/EntityHoverCard.tsx');
    const docs = source('docs/design-system.md');

    expect(model).toContain('return { title: element.name, summary: element.summary, meta };');
    expect(card).toContain('{content.title}');
    expect(docs).toContain('紧凑索引 / 名称列表');
    expect(docs).toContain('wrapping flex flow');
    expect(docs).toContain('`.element-panel-item-label`');
    expect(docs).toContain('固定 disclosure hit area');
    expect(docs).toContain('文本 label 单击进入 editor');
  });
});
