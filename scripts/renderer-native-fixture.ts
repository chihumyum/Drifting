import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { installHeadlessRendererGlobals } from '../src/dev-cli/headless-globals';
import { inspectNativeFixture, inspectNativeGraphFixture } from './renderer-native-db';

/** Synthetic author data only; use the production CLI domain runtime for all entity writes. */
async function main() {
  const directory = process.argv[2];
  assert(directory && path.isAbsolute(directory), 'An owned absolute fixture directory is required');
  // Claim a fresh directory before opening SQLite or applying any migration.
  // EEXIST must fail even for an empty directory: this tool never adopts data.
  await mkdir(directory);
  installHeadlessRendererGlobals();
  const [{ OfflineProductDatabase }, { executeOfflineWorkspaceTool }, { ProjectTable }] = await Promise.all([
    import('../src/dev-cli/offline-database'), import('../src/dev-cli/offline-workspace'),
    import('../src/renderer/schema/drizzle'),
  ]);
  const databaseFile = path.join(directory, 'drifting-library.db');
  const product = new OfflineProductDatabase(databaseFile, { migrate: true });
  await product.open();
  const startup = process.argv.includes('--startup');
  const specification = { version: 1, seed: startup ? 'renderer-native-startup-v1' : 'renderer-native-control-v1', ...(startup ? { firstEditorCharacters: 50000 } : {}), projects: [
    { id: 'native-control-a', chapters: 50, elements: 100, relations: 500, characters: 5000 },
    { id: 'native-control-b', chapters: 3, elements: 3, relations: 0, characters: 5000 },
  ] };
  const graphInteractions = process.argv.includes('--graph-interactions');
  let graph: Record<string, unknown> | undefined;
  const projects: Array<{ id: string; nodeIds: string[]; elementIds: string[] }> = [];
  const body = '合成数据只用于性能验收。春雨落在石阶上，远处的灯光照见空旷的长廊。';
  try {
    assert.equal(product.gateway.database.prepare('SELECT count(*) AS count FROM project').get()?.count, 0);
    for (const item of specification.projects) {
      const at = '2026-09-12T00:00:00.000Z';
      await product.client.insert(ProjectTable).values({ id: item.id, userId: 'drifting-library.db',
        name: `Synthetic ${item.id}`, summary: 'Generated acceptance project', kvJson: '[]',
        storylineTemplateKvJson: '[]', createdAt: at, updatedAt: at });
      let sequence = 0;
      async function call(toolName: string, args: Record<string, unknown>) {
        const result = await executeOfflineWorkspaceTool({ database: product.client, projectId: item.id,
          toolName, arguments: args, requestId: `${specification.seed}:${item.id}:${sequence++}` });
        assert.equal(result.result.ok, true, JSON.stringify({ toolName, result: result.result }));
      }
      await call('create_element_category', { name: 'Synthetic category' });
      await call('create_relation_type', { name: 'Synthetic appearance', orientation: 'directed',
        sourceRole: 'element', targetRole: 'chapter', sourceKinds: ['element'], targetKinds: ['chapter'] });
      for (let n = 0; n < item.chapters; n++) {
        const characters = startup && item.id === 'native-control-a' && n === 1 ? 50000 : item.characters;
        await call('create_chapter', { title: `Synthetic chapter ${String(n).padStart(3, '0')}`,
          body: body.repeat(Math.ceil(characters / body.length)).slice(0, characters) });
      }
      for (let n = 0; n < item.elements; n++) {
        await call('create_element', { category: 'Synthetic category', name: `Synthetic element ${String(n).padStart(3, '0')}`, summary: 'Generated fixture element' });
      }
      for (let n = 0; n < item.relations; n++) {
        await call('create_relation', { fromType: 'element', fromName: `Synthetic element ${String(n % item.elements).padStart(3, '0')}`,
          toType: 'chapter', toName: `Synthetic chapter ${String(Math.floor(n / item.elements)).padStart(3, '0')}`, relationType: 'Synthetic appearance' });
        if (n % 100 === 0) process.stdout.write(`Seeded ${item.id}: ${n}/${item.relations} relations\n`);
      }
      if (graphInteractions && item.id === 'native-control-a') {
        for (const name of ['Synthetic graph A', 'Synthetic graph B', 'Synthetic graph C']) await call('create_storyline', { name });
        for (const chapter of ['Synthetic chapter 046', 'Synthetic chapter 047']) {
          for (const storyline of ['Synthetic graph A', 'Synthetic graph C']) await call('add_chapter_to_storyline', { chapter, storyline });
        }
        await call('create_relation_type', { name: 'Synthetic graph link', orientation: 'directed',
          sourceRole: 'source', targetRole: 'target', sourceKinds: ['chapter', 'inspiration', 'element'], targetKinds: ['chapter', 'inspiration', 'element'] });
        for (let index = 0; index < 2; index++) await call('create_inspiration', {
          title: `Synthetic graph drift ${index}`, body: body.repeat(Math.ceil(5000 / body.length)).slice(0, 5000),
        });
        const findId = (table: string, field: string, value: string) => String(product.gateway.database.prepare(`SELECT id FROM ${table} WHERE project_id = ? AND ${field} = ?`).get(item.id, value)!.id);
        const placedId = findId('book_node', 'title', 'Synthetic chapter 046');
        // Fixture-only initial coordinates; the UI must perform all subsequent moves.
        product.gateway.database.prepare('UPDATE book_node SET narrative_order = 0 WHERE id = ?').run(placedId);
        graph = { projectId: item.id, placedId, unplacedId: findId('book_node', 'title', 'Synthetic chapter 047'),
          lineIds: ['Synthetic graph A', 'Synthetic graph B', 'Synthetic graph C'].map(name => findId('storylines', 'name', name)),
          driftIds: [0, 1].map(index => findId('book_node', 'title', `Synthetic graph drift ${index}`)),
          typeId: findId('entity_relation_type', 'name', 'Synthetic graph link'), elementId: findId('element', 'name', 'Synthetic element 000') };
      }
      const nodes = product.gateway.database.prepare("SELECT id FROM book_node WHERE project_id = ? AND deleted_at IS NULL AND kind = 'chapter' ORDER BY title").all(item.id);
      const elements = product.gateway.database.prepare('SELECT id FROM element WHERE project_id = ? AND deleted_at IS NULL ORDER BY name').all(item.id);
      assert.equal(nodes.length, item.chapters); assert.equal(elements.length, item.elements);
      assert.equal(product.gateway.database.prepare('SELECT count(*) AS count FROM entity_relation WHERE project_id = ?').get(item.id)?.count, item.relations);
      projects.push({ id: item.id, nodeIds: nodes.map(row => String(row.id)), elementIds: elements.map(row => String(row.id)) });
    }
    const observed = inspectNativeFixture(databaseFile);
    assert.equal(observed.chapters.length, 53 + (graphInteractions ? 2 : 0));
    for (const chapter of observed.chapters) {
      const characters = startup && chapter.projectId === 'native-control-a' && chapter.title === 'Synthetic chapter 001' ? 50000 : 5000;
      const expected = body.repeat(Math.ceil(characters / body.length)).slice(0, characters);
      assert.equal(chapter.characters, characters);
      assert.equal(chapter.sha256, createHash('sha256').update(expected).digest('hex'));
    }
    const structure = graph ? inspectNativeGraphFixture(databaseFile) : undefined;
    const semanticSha256 = structure ? createHash('sha256').update(JSON.stringify({ prose: observed.semanticSha256, nodes: structure.nodes, links: structure.links, markers: structure.markers })).digest('hex') : observed.semanticSha256;
    const manifest = { specification, semanticSha256, projects, ...(graph ? { graph } : {}) };
    await writeFile(path.join(directory, 'fixture.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write('Synthetic native fixture completed\n');
  } finally { await product.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
