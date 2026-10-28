/** Synthetic data only; exercises the production sidebar and reveal components. */
import { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChapterPanel } from '../src/renderer/components/leftBars/ChapterPanel';
import { ElementPanel } from '../src/renderer/components/leftBars/ElementPanel';
import { DriftPanel } from '../src/renderer/components/leftBars/DriftPanel';
import { LeftSidebarHeader } from '../src/renderer/components/leftBars/LeftSidebarHeader';
import { AgentEditAnimator } from '../src/renderer/components/editor/AgentEditAnimator';
import { WorkspaceNavigationProvider } from '../src/renderer/features/workspace/navigation/WorkspaceNavigationContext';
import { useAgentEditStore } from '../src/renderer/store/agent-edit-store';
import { useAgentActivityStore } from '../src/renderer/store/agent-activity-store';
import { useDataStore } from '../src/renderer/store/data-store';
import { useUiStore } from '../src/renderer/store/ui-store';
import { useAuthStore } from '../src/renderer/store/auth';
import { i18next as i18n } from '../src/renderer/lib/i18n';
import '../src/styles/index.css';
import '../src/styles/materials.css';
import '../src/styles/ui-controls.css';
import '../src/styles/agent-activity.css';
import '../src/styles/entity-editors.css';
import '../src/styles/comments-review.css';

const projectId = 'synthetic-unread-project';
const timestamp = '2026-10-17T00:00:00.000Z';
const common = { projectId, createdAt: timestamp, updatedAt: timestamp };
const node = (id: string, kind: 'chapter' | 'drift') => ({ ...common, id, kind, title: `Synthetic ${id}`, summary: '', bookOrder: kind === 'chapter' ? (id === 'chapter-a' ? 1 : 2) : null, narrativeOrder: 1, driftGroupId: kind === 'drift' ? 'drift-group' : null, writingStatus: kind === 'chapter' ? 'draft' : 'drifting', position: { x: 0, y: 0 }, wordCount: 3 });
useAuthStore.setState({ user: { id: 'synthetic-author' } as never });
useDataStore.setState({
  bookNodes: [node('chapter-a', 'chapter'), node('chapter-b', 'chapter'), node('drift-a', 'drift')] as never,
  storylines: [{ ...common, id: 'story', name: 'Synthetic Story', summary: '', contentJson: '{}', kvJson: '[]', nodeContentTemplateJson: '{}', color: '#888', sortOrder: 0 }] as never,
  nodeStorylineMapping: { 'chapter-a': ['story'], 'chapter-b': ['story'] },
  storylineNodeMapping: { story: ['chapter-a', 'chapter-b'] },
  primaryStorylineByNode: { 'chapter-a': 'story', 'chapter-b': 'story' },
  bookElementCategories: [{ ...common, id: 'category', name: 'Synthetic Category', color: '#888', contentJson: '{}', elementTemplateJson: '{}', elementTemplateKvJson: '[]' }] as never,
  bookElements: ['element-a', 'element-b'].map(id => ({ ...common, id, categoryId: 'category', name: `Synthetic ${id}`, summary: '', contentJson: '{}', kvJson: '[]', aliases: [], groupName: null, portraitAssetId: null })),
  driftGroups: [{ ...common, id: 'drift-group', name: 'Synthetic Drifts', parentId: null, sortOrder: 0, color: '#888' }] as never,
});
useUiStore.setState({ chapterViewMode: 'storyline', elementPanelViewMode: 'compact' } as never);
let serial = 0;
const opens: unknown[] = [];
const write = (type: 'node' | 'element' | 'storyline' | 'category', id: string) => useAgentEditStore.getState().recordReview(type, id, [{ blockId: 'paragraph', op: 'changed', oldText: 'Synthetic before', newText: 'Synthetic after', afterPrevId: null }], 'auto', { reviewId: `review-${++serial}`, effectId: `effect-${serial}` });
let showEditor: (id: string | null) => void = () => {};
const pulse = async () => { for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame); };
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
const findRow = (panel: string, name: string) => {
  const label = [...document.querySelectorAll<HTMLElement>(`[data-panel="${panel}"] span`)].find(el => el.textContent?.trim() === name);
  const row = label?.closest('.element-identity-tile') ?? label?.parentElement?.parentElement;
  assert(row, `Missing row ${panel}/${name}: ${document.querySelector(`[data-panel="${panel}"]`)?.textContent}`);
  return row!;
};
const indicator = (within: ParentNode) => { const el = within.querySelector<HTMLButtonElement>('button.agent-change-indicator'); assert(el, `Missing indicator in ${within instanceof Element ? within.outerHTML.slice(0, 800) : 'document'}`); return el!; };
const group = (panel: string) => document.querySelector<HTMLElement>(`[data-panel="${panel}"] .left-sb-group-header`)!;
const reset = async () => {
  showEditor(null); useAgentActivityStore.getState().clearAll(); useAgentEditStore.getState().clearAll(); opens.length = 0;
  for (const id of ['chapter-a', 'chapter-b', 'drift-a']) write('node', id);
  for (const id of ['element-a', 'element-b']) write('element', id);
  useAgentEditStore.getState().recordAddition('node', 'chapter-a');
  useAgentEditStore.getState().recordAddition('element', 'element-a');
  await pulse();
};
let hoverTarget: HTMLButtonElement;
const hoverMetrics = () => {
  const label = hoverTarget.querySelector<HTMLElement>('.agent-change-indicator__label')!;
  const glyph = hoverTarget.querySelector<HTMLElement>('.agent-change-indicator__read')!;
  const digit = document.createElement('span');
  digit.textContent = '0';
  digit.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
  hoverTarget.append(digit);
  const digitWidth = digit.getBoundingClientRect().width;
  digit.remove();
  const style = getComputedStyle(hoverTarget);
  return { width: hoverTarget.getBoundingClientRect().width, digitWidth,
    glyphWidth: glyph.getBoundingClientRect().width, glyphIsSvg: !!glyph.querySelector('svg'),
    labelOpacity: Number(getComputedStyle(label).opacity),
    glyphOpacity: Number(getComputedStyle(glyph).opacity), color: style.color, background: style.backgroundColor,
    border: style.border, radius: style.borderRadius, shadow: style.boxShadow };
};
let categoryTarget: HTMLElement;
const api = {
  async finishHoverTransition() {
    const label = hoverTarget.querySelector<HTMLElement>('.agent-change-indicator__label')!;
    const glyph = hoverTarget.querySelector<HTMLElement>('.agent-change-indicator__read')!;
    void getComputedStyle(label).opacity; void getComputedStyle(glyph).opacity;
    const animations = [label, glyph].flatMap(el => el.getAnimations());
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduced) {
      assert(animations.length === 2, 'Both glyphs must crossfade');
      for (const animation of animations) { animation.pause(); animation.currentTime = Number(animation.effect!.getTiming().duration) / 2; }
      const middle = hoverMetrics();
      assert(middle.labelOpacity > 0 && middle.labelOpacity < 1 && middle.glyphOpacity > 0 && middle.glyphOpacity < 1, 'Missing crossfade midpoint');
      for (const animation of animations) animation.finish();
    }
    await pulse();
    return { ...hoverMetrics(), animated: animations.length === 2 };
  },
  async prepareCategory(mode: 'compact' | 'list') {
    await i18n.changeLanguage('en'); showEditor(null);
    useAgentActivityStore.getState().clearAll(); useAgentEditStore.getState().clearAll(); opens.length = 0;
    useUiStore.setState({ elementPanelViewMode: mode }); await pulse();
    const header = group('elements');
    categoryTarget = header.querySelector<HTMLElement>('.left-sb-group-header__frame-label')
      ?? [...header.querySelectorAll<HTMLElement>('span')].find(el => el.textContent?.trim() === 'Synthetic Category')!;
    assert(categoryTarget, 'Missing category title');
    const rect = categoryTarget.getBoundingClientRect();
    assert(categoryTarget.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)), 'Category title cannot receive pointer events');
    if (mode === 'compact') {
      const legend = header.querySelector<HTMLElement>('.left-sb-group-header__legend')!;
      assert(!header.querySelector('.left-sb-group-header__count'), 'Grid category still shows an ordinary total');
      // The category's sand frame is the section's nine-sliced ::before; its
      // stroke runs through the middle of the frame's 12px top band, and the
      // legend's plate cuts it where the heading sits.
      const section = header.parentElement!;
      const add = header.querySelector<HTMLElement>('.left-sb-group-add')!.getBoundingClientRect();
      const slab = legend.getBoundingClientRect();
      const lineY = section.getBoundingClientRect().top + parseFloat(getComputedStyle(section, '::before').top) + 6;
      assert(slab.top <= lineY && slab.bottom >= lineY && slab.left <= rect.left && slab.right >= add.right, 'Legend does not mask count and action gaps');
      const probe = section.appendChild(document.createElement('i'));
      probe.style.background = 'var(--workspace-ui-bg)';
      const chrome = getComputedStyle(probe).backgroundColor;
      probe.remove();
      assert(getComputedStyle(legend).backgroundColor === chrome && !['transparent', 'rgba(0, 0, 0, 0)'].includes(chrome), 'Legend background is not opaque chrome');
      assert(getComputedStyle(section, '::before').pointerEvents === 'none', 'Frame line intercepts pointer events');
    }
    if (mode === 'list') assert(header.querySelector('.left-sb-group-header__count')?.textContent?.trim() === '· 2', 'List category lost its ordinary total');
    const frame = header.parentElement!.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
      frame: { x: Math.max(0, frame.left - 4), y: Math.max(0, frame.top - 4), width: frame.width + 8, height: frame.height + 8, scale: 2 } };
  },
  async categoryUnreadCount() {
    const count = () => group('elements').querySelector('.agent-change-indicator__label')?.textContent?.trim();
    write('element', 'element-a'); await pulse();
    assert(count() === '1', 'Category count must show unread Agent entities, not the total');
    write('element', 'element-b'); await pulse(); assert(count() === '2', 'Category unread count did not accumulate');
    useAgentActivityStore.getState().markSeen(['element:element-a']); await pulse();
    assert(count() === '1', 'Category unread count did not shrink after reading one element');
    const slot = group('elements').querySelector('.left-sb-group-header__count')!.getBoundingClientRect();
    const legend = group('elements').querySelector('.left-sb-group-header__legend')!.getBoundingClientRect();
    assert(slot.left >= legend.left && slot.right <= legend.right, 'Unread count escaped the frame mask');
    indicator(group('elements')).click(); await pulse();
    assert(!group('elements').querySelector('.left-sb-group-header__count'), 'Read changes restored an ordinary total in grid mode');
    assert(findRow('elements', 'Synthetic element-a') && findRow('elements', 'Synthetic element-b'), 'Acknowledging the count hid elements');
    return true;
  },
  async categoryPreview() {
    for (let i = 0; i < 200; i++) {
      const card = document.querySelector<HTMLElement>('[role="tooltip"]');
      if (card?.textContent?.includes('Synthetic Category') && getComputedStyle(card).visibility === 'visible') {
        assert(opens.length === 0, 'Hover navigated to category'); return true;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Category preview did not appear');
  },
  focusCategory() { categoryTarget.focus(); },
  async blurCategory() { categoryTarget.blur(); await pulse(); assert(!document.querySelector('[role="tooltip"]'), 'Category preview remained after blur'); return true; },
  async clickCategory() {
    categoryTarget.click(); await pulse();
    assert(opens.length === 1 && (opens[0] as { entityType: string }).entityType === 'category', 'Category click did not open exactly one editor');
    assert(!document.querySelector('[role="tooltip"]'), 'Category preview remained after opening editor');
    assert(group('elements').querySelector('[aria-expanded="true"]'), 'Category title click collapsed its contents');
    return true;
  },
  async prepareHover(kind: 'A' | 'M' | 'count') {
    await reset();
    hoverTarget = kind === 'count' ? indicator(document.querySelector('.agent-panel-tab')!)
      : indicator(findRow('chapters', kind === 'A' ? 'Synthetic chapter-a' : 'Synthetic chapter-b'));
    const rect = hoverTarget.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, ...hoverMetrics() };
  },
  hoverMetrics,
  async run() {
    await i18n.changeLanguage('en'); useUiStore.setState({ elementPanelViewMode: 'compact' }); await reset();
    assert(!document.querySelector('button button'), 'Nested interactive buttons');
    const tabsBefore = JSON.stringify(useUiStore.getState().desktopSidebarTabs);
    indicator(findRow('chapters', 'Synthetic chapter-a')).click(); await pulse();
    assert(!useAgentEditStore.getState().pending['node:chapter-a'] && !useAgentEditStore.getState().additions['node:chapter-a'], 'Chapter A acknowledgement failed');
    assert(useAgentEditStore.getState().pending['node:chapter-b'], 'Chapter acknowledgement escaped scope');
    assert(opens.length === 0, 'Indicator opened an editor');
    showEditor('chapter-a'); await pulse();
    assert(!document.querySelector('.agent-reveal'), 'Acknowledged chapter replayed reveal');
    await reset();
    indicator(findRow('elements', 'Synthetic element-a')).click(); await pulse();
    assert(!useAgentEditStore.getState().pending['element:element-a'] && opens.length === 0, 'Compact element A click failed');
    useUiStore.setState({ elementPanelViewMode: 'list' }); await pulse();
    indicator(findRow('elements', 'Synthetic element-b')).click(); await pulse();
    assert(!useAgentEditStore.getState().pending['element:element-b'], 'List element M click failed');
    await reset();
    indicator(findRow('drifts', 'Synthetic drift-a')).click(); await pulse();
    assert(!useAgentEditStore.getState().pending['node:drift-a'], 'Drift M click failed');
    await reset(); write('storyline', 'story'); await pulse();
    indicator(group('chapters')).click(); await pulse();
    assert(!useAgentEditStore.getState().pending['storyline:story'] && useAgentEditStore.getState().pending['node:chapter-a'], 'Group self M escaped scope');
    indicator(group('chapters')).click(); await pulse();
    assert(!useAgentEditStore.getState().pending['node:chapter-a'] && !useAgentEditStore.getState().pending['node:chapter-b'] && useAgentEditStore.getState().pending['element:element-a'], 'Group child count escaped scope');
    await reset();
    indicator(group('elements')).click(); await pulse();
    assert(!useAgentEditStore.getState().pending['element:element-a'] && useAgentEditStore.getState().pending['node:chapter-a'], 'Category child count escaped scope');
    for (const [index, keys] of [[0, ['node:chapter-a', 'node:chapter-b']], [1, ['element:element-a', 'element:element-b']], [2, ['node:drift-a']]] as const) {
      await reset();
      const tab = document.querySelectorAll('.agent-panel-tab')[index]; indicator(tab).click(); await pulse();
      assert(keys.every(key => !useAgentEditStore.getState().pending[key]), 'Tab count did not acknowledge its entities');
      assert(JSON.stringify(useUiStore.getState().desktopSidebarTabs) === tabsBefore && opens.length === 0, 'Tab count switched tabs or opened editor');
      assert(Object.keys(useAgentEditStore.getState().pending).length === 5 - keys.length, 'Tab count cleared another panel');
    }
    await reset(); showEditor('chapter-b'); await pulse();
    assert(document.querySelector('.agent-reveal'), 'Positive control: live unread reveal did not start');
    indicator(findRow('chapters', 'Synthetic chapter-b')).click(); await pulse();
    assert(!document.querySelector('.agent-reveal'), 'Acknowledgement did not stop active reveal');
    showEditor(null); await pulse(); showEditor('chapter-b'); await pulse();
    assert(!document.querySelector('.agent-reveal'), 'Reopened acknowledged editor replayed reveal');
    write('node', 'chapter-b'); await pulse();
    assert(document.querySelector('.agent-reveal'), 'A later Agent write did not reveal');
    assert(!document.querySelector('.agent-approve, .agent-review-all, .field-review__actions, .patch-card__review-actions'), 'Retired review controls remain');
    return { chapterAdded: true, compactElementAdded: true, listElementModified: true, driftModified: true, groupSelfAndChildren: true, categoryCount: true, allThreeTabCounts: true, clickIsolation: true, noNestedButtons: true, acknowledgedEditorSkipsReveal: true, activeRevealCancelled: true, laterWriteUnread: true, reviewControlsAbsent: true };
  },
};
Object.assign(globalThis, { __AGENT_UNREAD_UI__: api });
function Fixture() {
  const [editorId, setEditorId] = useState<string | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => { showEditor = setEditorId; }, []);
  return <WorkspaceNavigationProvider navigator={{ projectId, open: target => opens.push(target), activate() {}, showProjectHome() {}, leaveDeletedTarget() {} }}>
    <LeftSidebarHeader paneId="primary" activeTab="nodes" />
    <div style={{ display: 'flex', gap: 16, height: 320 }}>
      <div data-panel="chapters" style={{ width: 280 }}><ChapterPanel /></div>
      <div data-panel="elements" style={{ width: 280 }}><ElementPanel /></div>
      <div data-panel="drifts" style={{ width: 280 }}><DriftPanel /></div>
    </div>
    {editorId && <div ref={setScrollEl} className="editor-scroll" style={{ height: 240, overflow: 'auto' }}>
      <div className="editor__spread" style={{ position: 'relative' }}><div className="ProseMirror"><p data-block-id="paragraph">Synthetic after</p></div></div>
      <AgentEditAnimator scrollEl={scrollEl} projectId={projectId} entityType="node" id={editorId} />
    </div>}
  </WorkspaceNavigationProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
