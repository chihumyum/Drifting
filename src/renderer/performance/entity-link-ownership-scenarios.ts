import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { EntityLink, configureEntityLinkAutoDetect, flushPendingAutoDetect, isEntityLinkAutoDetectEnabled, type EntityLinkAutoDetectConfig } from '../lib/extensions/entity-link';
import { buildEntityAutoDetectTargets, selectEntityLinkNames } from '../lib/entity-link-names';
import { createSyntheticWorkspaceProjection } from './fixture';

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Real mounted editors with different exclusions, including inactive surfaces. */
export async function runEntityLinkOwnershipScenarios() {
  const checks: { id: string; passed: true }[] = [];
  const check = (id: string, valid: boolean) => {
    if (!valid) throw new Error(`Entity link ownership failed: ${id}`);
    checks.push({ id, passed: true });
  };
  const groups = [];
  for (const count of [1, 5, 20]) {
    const fixture = createSyntheticWorkspaceProjection('synthetic-link-ownership', count + 1, 1);
    fixture.bookNodes = fixture.bookNodes.map((node, index) => ({ ...node, title: `合成章节【${index}】` }));
    const names = selectEntityLinkNames({ ...fixture, workspaceProjectId: 'synthetic-link-ownership', workspaceProjectionEpoch: 1 });
    const prose = fixture.bookNodes.map((node) => node.title).join('，');
    const editors: Editor[] = [];
    const hosts: HTMLElement[] = [];
    const configs: EntityLinkAutoDetectConfig[] = [];
    let extra: Editor | undefined;
    const create = (config: EntityLinkAutoDetectConfig, text: string) => {
      const element = document.createElement('div');
      document.body.appendChild(element);
      hosts.push(element);
      return new Editor({ element, extensions: [StarterKit, EntityLink.configure(config)],
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } });
    };
    const targetIds = (editor: Editor) => Array.from(editor.view.dom.querySelectorAll('[data-target-id]'), (element) => element.getAttribute('data-target-id'));
    try {
      for (let index = 0; index < count; index++) {
        const config = { autoDetectTargets: buildEntityAutoDetectTargets(names, 'node', fixture.bookNodes[index].id), autoDetectEnabled: true };
        configs.push(config);
        editors.push(create(config, prose));
        hosts[index].style.visibility = index === 0 ? 'visible' : 'hidden';
      }
      // Let extension creation callbacks run: the old global onCreate would
      // overwrite every previous editor's exclusions at this boundary.
      await pause(20);
      for (const editor of editors) flushPendingAutoDetect(editor);
      const correctEditors = editors.filter((editor, index) => {
        const targets = targetIds(editor);
        return targets.length === count && !targets.includes(fixture.bookNodes[index].id) && editor.state.doc.textContent === prose;
      }).length;
      check(`${count}:all-editors-retain-self-exclusion`, correctEditors === count);
      groups.push({ editors: count, correctEditors });

      const [first] = editors;
      const ownTitle = fixture.bookNodes[0].title;
      const changedTargets = new Map(configs[0].autoDetectTargets);
      changedTargets.set(ownTitle, { kind: 'element', id: 'synthetic-override' });
      configureEntityLinkAutoDetect(first, { autoDetectEnabled: true, autoDetectTargets: changedTargets });
      flushPendingAutoDetect(first);
      check(`${count}:live-config-update-preserves-editor`, targetIds(first).includes('synthetic-override') && first.state.doc.textContent === prose);
      for (let index = 1; index < editors.length; index++) {
        flushPendingAutoDetect(editors[index]);
        check(`${count}:${index}:other-view-config-unchanged`, !targetIds(editors[index]).includes('synthetic-override'));
      }

      // Same element/parent rules are used by element prose and patch editors.
      const element = fixture.bookElements[0];
      for (const kind of ['element', 'patch'] as const) {
        const config = { autoDetectEnabled: true, autoDetectTargets: buildEntityAutoDetectTargets(names, kind, kind === 'element' ? element.id : 'synthetic-patch', kind === 'patch' ? element.id : undefined) };
        extra = create(config, `${element.name} ${element.aliases[0]} ${ownTitle}`);
        flushPendingAutoDetect(extra);
        check(`${count}:${kind}:self-or-parent-excluded`, !targetIds(extra).includes(element.id) && targetIds(extra).includes(fixture.bookNodes[0].id));
        extra.destroy(); extra = undefined;
      }

      // Disable while a typing debounce is pending, then re-enable and flush.
      first.commands.setContent('<p>未匹配</p>');
      first.view.dispatch(first.state.tr.insertText(ownTitle, 1));
      configureEntityLinkAutoDetect(first, { autoDetectTargets: changedTargets, autoDetectEnabled: false });
      await pause(550);
      check(`${count}:disable-cancels-pending-work`, !isEntityLinkAutoDetectEnabled(first) && targetIds(first).length === 0);
      configureEntityLinkAutoDetect(first, { autoDetectTargets: changedTargets, autoDetectEnabled: true });
      flushPendingAutoDetect(first);
      check(`${count}:reenable-flushes-current-context`, targetIds(first).includes('synthetic-override'));

      // A pending timer must not dispatch into a destroyed view.
      let transactions = 0;
      first.on('transaction', () => { transactions++; });
      first.view.dispatch(first.state.tr.insertText(ownTitle, 1));
      first.destroy();
      const atDispose = transactions;
      await pause(550);
      check(`${count}:destroy-cancels-pending-work`, transactions === atDispose && !isEntityLinkAutoDetectEnabled(first));
    } finally {
      extra?.destroy();
      for (const editor of editors) if (!editor.isDestroyed) editor.destroy();
      for (const host of hosts) host.remove();
    }
  }
  return { groups, checks };
}
