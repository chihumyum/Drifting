import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const source = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('authoritative relation type UI boundary', () => {
  it('projects, filters, and colors relations only by relationTypeId', () => {
    const model = source('src/renderer/features/graph/story-graph-model.ts');
    const metadata = source('src/renderer/hooks/useEdgeKindMeta.ts');
    const menu = source('src/renderer/components/ui/RelationKindMenu.tsx');

    expect(model).toContain('relationTypeId: string;');
    expect(model).not.toContain('kind: string');
    expect(metadata).toContain('const STORAGE_VERSION = 2;');
    expect(metadata).toContain('byRelationTypeId');
    expect(metadata).not.toContain('UNCATEGORIZED_META_KEY');
    expect(metadata).not.toContain('reassign');
    expect(menu).toContain('setRelationTypeColor(type.id, paletteColor)');
    expect(menu).toContain('disabled={type.locked}');
    expect(menu).not.toContain('updateRelationKind');
    expect(menu).not.toContain('UNCATEGORIZED_RELATION_KIND');
  });

  it('routes TODO and material pickers through the built-in generic association', () => {
    const todo = source('src/renderer/components/rightBars/TodoPanel.tsx');
    const library = source('src/renderer/features/library/LibraryPanel.tsx');
    const overview = source(
      'src/renderer/shells/desktop/views/DesktopSuperMemoMaterialView.tsx',
    );

    for (const file of [todo, library, overview]) {
      expect(file).toContain('addGenericAssociation');
      expect(file).toContain('genericAssociationRelationTypeId');
    }
    expect(todo).not.toContain("addRelation('comment'");
    expect(library).not.toContain("addRelation('library_item'");
    expect(overview).not.toContain("addRelation('comment'");
    expect(overview).not.toContain("addRelation('library_item'");
  });

  it('localizes canonical built-in relation copy by systemKey', () => {
    const presentation = source(
      'src/renderer/hooks/useRelationTypePresentation.ts',
    );
    const zh = JSON.parse(source('src/renderer/locales/zh-CN.json')) as {
      relationTypes: { genericAssociation: { name: string } };
    };
    const en = JSON.parse(source('src/renderer/locales/en.json')) as {
      relationTypes: { genericAssociation: { name: string } };
    };

    expect(presentation).toContain('GENERIC_ASSOCIATION_SYSTEM_KEY');
    expect(presentation).toContain("t('relationTypes.genericAssociation.name')");
    expect(presentation).toContain("t('relationTypes.genericAssociation.description')");
    expect(presentation).toContain("t('relationTypes.genericAssociation.sourceRole')");
    expect(presentation).toContain("t('relationTypes.genericAssociation.targetRole')");
    expect(zh.relationTypes.genericAssociation.name).toBe('关联');
    expect(en.relationTypes.genericAssociation.name).toBe('Association');
  });
});
