import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9) ?? 'docs/apple-native/acceptance/p2b-binding.json';
const directory = '.local-data/apple-native/binding';
const actBoundaryCase = 'Workspace act boundaries retain outline expansion chapter owners selection and history through create rename remove and cold reopen';
const commentCases = [
  'AppKit selection comment highlights both same-chapter views lists and locates only in the initiating pane without authoring history and survives cold reopen',
  'AppKit comment body edit resolve and reopen keep prose selections anchors and undo history and survive cold reopen',
  'AppKit comment refusals for stale revision blank selection empty body failed commit queued and marked input create nothing and keep composer text',
];
const elementLibraryCases = [
  'AppKit element page tabs beside chapter tabs and in the second pane keep independent owners text selections and history through cold reopen',
  'AppKit element page header edits name aliases summary group and category, refuses conflicts without writing and keeps typed text while tabs follow renames',
  "AppKit element trash closes only that element's tabs after commit and restore reopens its body while chapter tabs stay untouched",
];
const elementFactsCases = [
  'AppKit element page facts add edit reorder and delete rows as one ordered untrimmed list, keep typed rows on refusal, follow the other page and survive cold reopen',
  'AppKit category template facts edited in the library sheet clone into an element created through the panel while older elements and the template stay independent',
  'AppKit category trash moves its elements to 未分类 with open element tabs retained and category popups updated, refuses a stale template save and restore does not re-attach',
];
const entityLinkCases = [
  'AppKit typed element names link after the input debounce in the category colour with a delayed hover preview, keep the caret, wait for composition, and one undo reverts only the typed text',
  'AppKit element creation, rename, aliases and chapter rename retro-link open chapters; ⌘-click and 打开 open the target, trashed targets dim, restored targets recolour and missing targets read as prose',
  'AppKit element page 被引用 lists open and closed chapters with block and link counts, follows edits and selects the first link only while it is still linked',
];
const storylineCases = [
  "AppKit first storyline created in the panel becomes every chapter's 主线 with its colour in the outline, and a second storyline, suffixed renames, recolour, summary and drag or menu reorders follow in the panel, pages and tabs",
  'AppKit chapter 故事线 sheet from the outline adds and removes storylines and moves 主线, reflected in outline dots and storyline page chapter lists in book order, and survives cold reopen',
  'AppKit storyline trash after confirmation clears chapters whose 主线 it was and removes it elsewhere, restore keeps chapters unlinked, chapter trash and restore keep storylines, a stale sheet is refused, and page facts and body survive cold reopen',
];
const driftCases = [
  'AppKit drift panel creates groups, a subgroup and drifts, shows the one-level nesting refusal without writing, renames and moves drifts from the panel and page with titles unique across chapters, folds groups, and deleting groups lifts subgroups and drifts through cold reopen',
  "AppKit drift page body keeps its own owner and history and survives cold reopen, chapter prose links the drift title and retro-links a new drift, ⌘-click opens the drift page, and a trashed drift's link dims until restore",
  'AppKit act notes bound from the outline picker show on the act row and drift page and follow an act rename, a stale bind is refused, queued input blocks the trash, trash unbinds and closes the tab only after commit, restore returns it unbound, and unbinding or removing an act keeps the drift',
];
const metadataCases = [
  'AppKit chapter page 摘要 and 状态 trim and write once, skip unchanged, Escape and refused edits without journal rows, follow the split pane and the outline status and 操作 menu, keep body history and survive cold reopen',
  'AppKit drift page 摘要 and 状态 reach the panel, which mutes 休眠 drifts and offers the other status in its row menu, the current status and a chapter status write nothing, and statuses survive cold reopen into a new panel, read with every live chapter\'s and drift\'s metadata in one nodes read',
  'AppKit project sheet trims 本书简介, edits 本书字段 and 故事线字段模版 as ordered untrimmed lists, writes nothing when unchanged, keeps typed rows and stays open on refusal, 完成 saves pending edits, a new storyline clones the template while an older one stays unchanged, and everything survives cold reopen',
];
const relationCases = [
  'AppKit 关系类型 manager creates a directed and a symmetric type, refuses a duplicate name and built-in edits without writing, edits a type, writes nothing when unchanged and deletes an unused type after confirmation',
  'AppKit 关系 sections on element, chapter, drift and storyline pages add relations through the sheet and an inline type, refuse a reversed direction in the sheet, the inline editor and Rust without writing, list a symmetric edge on both sides, open the other entity and follow renames',
  'AppKit 关系 row menus swap a directed relation, retype it with and without swapped ends, write nothing for the current type, remove a relation and refuse deleting a type in use, with every open section following each reply',
  "AppKit element trash purges its relations inside the trash original and from the other entities' open sections, restore does not bring them back, the freed type deletes, and types and relations survive cold reopen",
];
const wordCountCases = [
  'AppKit CJK and Latin typing in a chapter page updates its header, the outline row, the status line and the project sheet total after one debounced read per burst, an unchanged save reads nothing, undo and redo follow, a 1,234-word chapter reads 1.2k in rows, and counting and reconcile write no journal rows or stamps',
  "AppKit drift page and 漂流 panel rows show the drift's count while the book total counts chapters only, and drift trash and restore remove and return it without journal rows from counting",
  'AppKit project open reconciles stale and uncounted chapters that were never opened, showing 统计中… until every chapter is counted and nothing for an uncounted row, without journal rows or stamp changes',
  'AppKit chapter trash removes its count from the book total and outline and restore returns it, and a cold reopen shows 统计中… in the page header until the reconciled counts match',
];
const agentCases = [
  "AppKit 写作助手 streams one reply from each of DeepSeek, Anthropic and OpenAI through a stubbed URLProtocol, renders its Markdown-light text, and sends each provider's request shape with the model, the Chinese system prompt, the open-chapter line, seventeen tools and the key only in its auth header",
  "AppKit 写作助手 runs a DeepSeek thinking tool loop of list_chapters, read_chapter of the open chapter's live text and an answer, replays reasoning_content inside the turn, shows each tool as an activity line and stops cleanly after 24 tool rounds",
  "AppKit revise_chapter proposal changes nothing until 接受, then applies through Rust into the open editor as one undo step with Agent provenance for its session, turn and call; 拒绝 leaves the text, a refused original shows Rust's message, and the next turn tells the model every outcome",
  'AppKit 停止 mid-stream keeps the partial reply and closes the request, and a missing key, HTTP 401, HTTP 429 and an offline network show Chinese errors without sending or storing the key',
  'AppKit create_chapter with opening text and set_chapter_summary proposals from one parallel tool call apply on 接受: the chapter joins the book with its paragraphs written as one Agent append and the open page shows the stored summary',
  'AppKit append_to_body proposal shows the added paragraphs and changes nothing until 接受, then appends them to the open chapter as one Agent undo step with provenance, undo and redo follow, and a blank or mixed append is refused before any proposal',
  'AppKit conversations persist per project as atomic JSON beside the lab workspace and survive a cold reopen of the panel with messages, proposal states and model choice; rename, delete after confirmation and a pending proposal accepted after reopen work, and the key sheet stores and clears keys showing only a masked tail',
];
const libraryCases = [
  "AppKit 素材库 imports a generated PNG and PDF through 导入文件… and a dropped JPEG, shows image and PDF cards whose downsampled thumbnails load, adds a link showing its host that opens in the browser and a note from the sheet, previews files through Quick Look and the space bar, and refuses a dropped text file, a javascript: link and Rust's missing-file and folder imports in Chinese without writing",
  "AppKit 素材库 renames through 重命名… and edits an image's notes and a note's body and notes through the sheet with one field.set per changed field, writes nothing for unchanged or empty titles, and deletes after confirmation, removing the card, the stored bytes and the item with one purge",
  'AppKit element page 肖像 shows the placeholder, sets a generated PNG through 设置肖像…, replaces it by a dropped JPEG releasing the previous bytes, follows in the second pane and the 设定库 row, refuses a PDF without writing and 移除肖像 clears it back to the placeholder',
  'AppKit 文件 › 导入… parses Markdown into a new chapter and plain text into a new element of the chosen category through the sheet with guessed and edited titles, a Word document with a larger heading into a 漂流, opening each page with its headings and paragraphs and the bold and italic runs of Markdown and Word; 导出全书… writes UTF-8 Markdown with those marks and plain text; and the library, portrait and imported bodies survive a cold reopen',
];
const timelineCases = [
  'AppKit 故事图谱 shows one lane per storyline in authored order and 未归属 for chapters without a primary, each chapter card in its primary\'s lane at its book position with its § number, status and word count, and card menus open a chapter and set its status with one field.set',
  'AppKit 故事图谱 book-order drag of a card sends nothing until the drop, then reorders chapters through the chapter move with one original that the chapter list and memberships follow, and a drop back in its slot writes nothing',
  'AppKit 故事图谱 drag across lanes and 移到轨道 make the target storyline primary, drop the previous primary\'s membership, keep other memberships and clear them all in 未归属, matching the storyline library and the tab host',
  'AppKit 故事图谱 故事时间 places chapters from the 未放置 tray at orders from their neighbours, reorders them by drag, changes lane and order in one drop as one moveChapter original, refuses a drop into a storyline trashed elsewhere and a non-finite order leaving both the lane and the order unchanged, and 移出故事时间 or a drop on the tray sets null, one field.set per change and none for a drop in place',
  'AppKit 故事图谱 markers are created from 添加标记… and the marker row, renamed, bound to a drift that captions a label-less marker, dragged to a new narrative order, unbound keeping the caption and deleted after confirmation, numeric labels convert story time and an unnamed unbound marker is refused without writing',
  'AppKit 故事图谱 drift cards flow until placed, a drag stores the position inside the area as one tuple.set, a click-sized drag writes nothing and double-click or 打开 opens the drift',
  'AppKit 故事图谱 narrative orders, lanes, book order, markers with their bindings and drift positions survive a cold reopen into a new graph',
  'AppKit 故事图谱 lays out 200 chapters as layer-backed cards and a drag across them sends no Rust call and no render until the drop, which moves the chapter once',
];
const historyCases = [
  'AppKit 历史版本 times read 刚刚, N 分钟前, 今天, 昨天, a date this year and a date with its year, and rows name why a version was kept (自动保存, 关闭时, 恢复前) and its word count, leaving both out for older versions',
  'AppKit 历史版本 lists versions captured on save and close newest first with relative times, the title at that time, why each was kept and its word count, capturing without journal rows, reachable from every page kind\'s pane header',
  'AppKit 历史版本 previews the selected version read-only, marking text the current body lacks on a green wash and struck-through text the version lacks, identical versions as such, and the plain version without the diff',
  'AppKit 历史版本 restore into an open chapter after confirmation updates the editor in place with one original, keeps the replaced text as a version, and one undo returns the text before redo restores the version; restoring over newer text keeps it as a version marked 恢复前 with its word count',
  'AppKit 历史版本 restore into a closed chapter through a temporary owner and into an open element page reaches the stored body and the editor',
  'AppKit 历史版本 refuses a version of another body, a missing version and queued input in Chinese in the sheet without changing the body or the journal, and cancelling the confirmation writes nothing',
];
const editingCases = [
  'AppKit Enter typed at the end of a just-settled line holding a linkable chapter title, while its link pass is scheduled, becomes a new paragraph with no failed draft, keeps the link and survives cold reopen',
];
const settingsCases = [
  'AppKit 设置 font source, size, line height, paragraph indent, manuscript language, theme, accent and spelling restyle every open editor in both panes and a hidden tab in place, keep text, selection and history, match the full style reference after typing, and 还原推荐样式 restores the defaults',
  'AppKit 设置 imports a generated TrueType font into the lab data directory, registers it for this process only and sets prose in it with CJK falling back to the serif, replaces and removes it with its copy, and refuses a damaged file and a text file in Chinese without changing anything',
  'AppKit 设置 persist in settings.json in the lab data directory and survive a cold relaunch of the store, window and tab host with the imported font registered again and every control and open editor restored',
  'AppKit 设置 fall back to the system serif with a Chinese message when a chosen system family is uninstalled or the imported copy is missing or damaged, and refuse an unknown family without changing the font',
];
const categoryCases = [
  'AppKit 设定库 opens a category page (分类页) by double-click and 打开分类页 as a tab beside chapter and element tabs, whose header renames and recolours with one field.set each, edits 模板字段 as ordered rows, follows the 设定库 and a second pane, and whose body keeps its own undo apart from the chapter and survives cold reopen',
  "AppKit 新设定模版 sheet on a category page edits headings and paragraphs with bold and italic on a selected range and Return adding a paragraph, previews how a new element starts, writes one field.set on 保存 and nothing when unchanged, shows Rust's range refusal in Chinese keeping the rows, elements created from the 设定库 and from the page open with the template body, and 清空模版 returns new elements to an empty body through cold reopen",
  'AppKit 关系 from an element page to a category names the category, its row opens the 分类页 in that pane whose 关系 lists the relation back, 历史版本 lists and restores the category body as one undoable edit, and the writing assistant reads the category and revises its open body on 接受',
  "AppKit category trash from the 设定库 after confirmation closes the category's tabs in both panes and its template sheet only after the commit while element and chapter tabs stay, restore lists it again and its page reopens with the body, 模板字段 and template through cold reopen",
];
const wholeBookCases = [
  'AppKit 全书长卷 opens 200 synthetic chapters in book order with act separators, keeps row views, editors and owners only near the viewport (at most six editors, plus the chapter being written in), attaches and releases them while scrolling to the end with no main-thread step over 100 ms and nothing written to the journal, and text typed in chapter 3 just before scrolling far away is saved, its owner closed and shown again on return',
  'AppKit 全书长卷 edits, undo and redo in an attached chapter go through the owner a tab of that chapter shares, typed element names link, a comment reaches the tab, word counts follow in the header and 统计, a closed tab leaves the owner to the long page, ⌘-click opens the element, and releasing closes only owners no tab shows',
  "AppKit 全书长卷 scrolls to a chapter or a heading chosen in the 整书大纲 and to chapters and acts in the 跳到 menu, attaching the chapter's editor at the top of the viewport with the caret on the heading",
  "AppKit 统计 reads 统计中… until every chapter is counted, then the total, chapter count, average, completion and written/target progress of a synthetic book, colours each chapter bar by its act, lists each act's chapters and words, and a click on a bar scrolls the 全书长卷 to its chapter",
  "AppKit 写作计划 in 项目资料 parses and stores the target and daily goal per project in settings.json with the book's progress, refuses unreadable input without saving, writes nothing to the journal, and restores both after a cold relaunch of the workspace and settings",
];
const elementOverviewCases = [
  'Swift 设定总览 solver packs automatic category boxes largest first on the side that keeps them lowest while balancing area above and below the band, routes them around pinned boxes, snaps a pinned box that crosses the band to the nearer side, sizes and groups boxes as the renderer does and places the same boxes identically in any input order',
  'AppKit 设定总览 shows the book\'s chapters in book order across the band grouped by act in storyline lanes, category boxes above and below it holding their element cards in groups, 未分类 for elements without a category and an empty category as 空, opens from the 设定库\'s 总览, and pans by drag and scroll and zooms by ⌘-scroll, ⌘+, ⌘− and ⌘0 within 40%–200% writing nothing',
  'AppKit 设定总览 dragging a category box pins it to the cell under the drop with one original of field.set placements, snaps a box dropped across the band to the nearer side, packs automatic boxes around the pins, writes nothing for a drop in place or a click-sized drag, returns it to the solver with 恢复自动排列 (offered only for pinned boxes), and keeps pins and the viewport (settings.json) through a cold relaunch',
  'AppKit 设定总览 draws relation edges between element cards and chapter pills, selects an edge to show its ends and type and retypes, swaps and removes it through the shared relation library that page 关系 sections follow, creates relations by ⌥-drag, Shift-click and the card menu in the 新建关系 sheet, and refuses a reversed type, a self relation (Rust\'s Chinese refusal) and a cancelled sheet without writing',
  'AppKit 设定总览 opens an element card\'s page, a legend\'s 分类页 and a double-clicked chapter pill as tabs in the tab host, a single click on a pill opens nothing, and 移到回收站 from a card\'s menu trashes the element through the tab host and removes its card and edges',
  'AppKit 设定总览 follows changes made elsewhere without reopening: elements created and categories renamed in the 设定库, an element renamed on its page and recategorised, a category trashed moving its elements to 未分类, a relation added through a page\'s relation library, chapters created and renamed, a lane change, drifts in the 漂流 row with their edges, and a remote chapter original',
  'AppKit 设定总览 lays out 60 chapters in 3 acts and 3 lanes, 20 categories, 300 elements and 400 relations with the solver under 100 ms and no main-thread pass (open, refresh, pan, zoom, sharpen) over 100 ms in a debug build, and opening, panning and zooming write nothing to the journal',
];
const reviewCases = [
  'AppKit 审阅 composes a note on the focused chapter, a TODO on it with a priority and a floating TODO associated with it, lists 全部/批注/待办 and 当前 (whole page first, then passage notes, then associated items, each newest first) or 全书, follows the focused tab, and refuses an empty body, a note without a page and Rust\'s floating note in Chinese without writing',
  'AppKit 审阅 sets and clears a priority with one field.set each and none for the current one, resolves and reopens under 已解决 and from the board\'s 已完成 archive, converts a passage note to a TODO and back keeping its anchor, refuses making a floating TODO a note in Chinese without writing, and edits a body through the composer writing nothing when unchanged',
  'AppKit 审阅 定位 opens a note\'s page as a tab and selects a passage note\'s anchored text, deletes only after confirmation, refuses while the chapter has marked input, removes a passage note with its highlight from both open views and the chapter\'s comment panel while typing continues and saves through cold reopen, and deletes an associated TODO with its relations in one original',
  'AppKit 关联 of TODOs and library items with chapters, drifts, elements, categories and storylines through menus and chips writes one entity-relation original each, stays out of pages\' 关系 sections, follows a rename and survives a cold relaunch',
  'AppKit 备忘与素材 board shows open TODO cards beside the library\'s cards with kind chips and counts that hide and show 待办, 图片, PDF, 链接 and 文字, reorders library items by drag with one order original also while a kind is hidden, writes nothing for a drop in place, and keeps the order through a cold relaunch',
  'AppKit 幕颜色 from the 整书大纲 and a 全书长卷 separator stores one field.set per change and nothing for the current colour, the separator wash, 统计 strip, act rows and chapter bars follow while other acts keep the hue cycle, 恢复默认 clears it, and colours survive a cold relaunch',
  'AppKit 删除项目 names what is removed, enables 删除项目 only for the exact typed name, refuses in Chinese with nothing written while a tab has marked input or an owner outside the tabs is open, closes the 全书长卷 and every tab of the project first, deletes with one sync-generation purge and the asset bytes, switches to the remaining project, is gone after a cold relaunch, and deleting the last project opens a new empty one',
];
const workspaceTrashCases = [
  'Workspace trash removes all chapter displays after commit and restores through a fresh owner',
  'Workspace trash preserves queued marked and failed-save drafts and rolls back a failed lifecycle transaction',
];
const workspaceRemoteChangeCases = [
  'AppKit remote chapter creation refreshes workspace lists and remains editable after cold reopen',
  'AppKit remote metadata preserves the live owner selection and history and rejects invalid originals atomically',
];
const workspaceRemoteCases = [
  'AppKit canonical remote originals preserve queued Unicode input passive selection and local undo',
  'AppKit canonical remote originals preserve marked branches through native commit and cancellation',
  'AppKit duplicate and explicit reconciliation refresh every retained chapter without rewriting receipts',
  'AppKit rejected originals and committed checkpoint failure retain owners drafts and retry through cold reopen',
];
const searchCases = [
  'AppKit project search reads live and cold chapter text without changing owners or history',
  'AppKit search revalidates anchored Unicode matches and preserves other pane selection and history',
  'AppKit search guards queued and marked input and discards superseded query results',
];
const workspaceCases = [
  'Workspace tabs retain chapter owners views selections and independent history',
  'Workspace split panes share one chapter owner and preserve independent selections after closing one pane',
  'Workspace close guards retain queued marked and failed-save input through retry and cold reopen',
];
const prefixDeletionCases = [
  'AppKit queued Enter after partial remote prefix deletion preserves two views, comments, history and reopen',
  'AppKit queued Enter after complete remote prefix deletion preserves two views, comments, history and reopen',
];
const partialQuoteCase = 'AppKit partial quote deletion preserves queued typing, two-view selections, comments, suffix history and reopen';
const relocationCases = [
  'AppKit refused relocation history preserves remote formatting and keeps both views editable',
  'AppKit late original prefix after partial quote deletion converges across two views history duplicate delivery and reopen',
  'AppKit late original prefix after quote join converges across two views history duplicate delivery and reopen',
  'AppKit mixed late prefix and safe suffix after partial quote deletion preserve two views selections item identity history and reopen',
  'AppKit mixed late prefix and safe suffix after quote join preserve two views selections item identity history and reopen',
  'AppKit interleaved Unicode prefix and safe suffix clocks after partial quote deletion preserve two views selections item identity history and reopen',
  'AppKit interleaved Unicode prefix and safe suffix clocks after quote join preserve two views selections item identity history and reopen',
];
const remoteBlockCases = [
  'AppKit stored but unapplied remote update preserves marked input and shared recovery status',
  'AppKit stored but unapplied remote update preserves queued input and blocks history, retry compaction and reopen',
];
const remoteRecoveryCases = [
  'AppKit durable dependency recovery bypasses held local jobs then drains exact queued input through history and reopen',
  'AppKit durable dependency recovery preserves marked branch until native commit and keeps remote text through history and reopen',
];
const styleCases = [
  'AppKit outline resolves current heading identity without moving passive views or authoring history',
  'AppKit outline survives prefix edits history and reopening while guarding marked input',
  'AppKit native multiblock formatting shares styles selection one-step history and persisted structure',
  'AppKit heading levels body reset and container refusal preserve links comments and usable input',
  'AppKit incremental style matches full reference at every UTF-16 position',
  'AppKit local Unicode styling uses one-block path and authoritative no-op skip',
  'AppKit composition commit and cancellation clear temporary text-system styling',
  'AppKit bold link italic strike and comment boundaries retain full-reference attributes',
  'AppKit remote format-only styling refreshes unchanged text',
  'AppKit structural style fallback matches full reference',
  'AppKit comment-only projection refresh removes stale highlights',
  'AppKit revision and selection-only refresh skips styling',
  'Canonical-equivalent text replacement retains exact scalar and UTF-16 identity',
  'AppKit canonical replacement refreshes passive views and history',
  'AppKit canonical composition commits as one exact undo unit',
  'Remote canonical text refresh and SQLite reopen retain exact storage ranges',
];
const run = (command, args, env = {}) => execFileSync(command, args, {
  encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 300000, env: { ...process.env, ...env },
});
const sourceFiles = () => [...new Set(run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0'))]
  .filter(file => file && existsSync(file) && (/^(crates\/|vendor\/yrs\/|native\/apple\/|drizzle\/)/.test(file)
    || ['scripts/apple-binding-acceptance.mjs', 'scripts/apple-quote-history-oracle.ts',
      'src/renderer/components/editor/chapter-static-html.ts', 'src/renderer/lib/extensions/block-id.ts',
      'src/renderer/lib/extensions/paragraph-indent.ts', 'src/renderer/lib/extensions/entity-link.ts',
      'src/renderer/domain/entity-kinds.ts', 'src/renderer/lib/retroactive-entity-links.ts',
      'docs/apple-native/fixtures/document-v1.json', 'package.json', 'pnpm-lock.yaml'].includes(file))).sort();
const hash = value => createHash('sha256').update(value).digest('hex');
const fingerprint = () => hash(JSON.stringify(sourceFiles().map(path => ({ path, hash: hash(readFileSync(path)) }))));
const report = { schemaVersion: 1, kind: 'apple_native_p2b_first_binding', status: 'running', generatedAt: new Date().toISOString(),
  scope: 'Headless Swift coordinator, Rust ABI, SQLite and programmatic AppKit text input',
  source: { commit: run('git', ['rev-parse', 'HEAD']).trim(), dirty: Boolean(run('git', ['status', '--porcelain']).trim()), fingerprint: fingerprint() },
  cases: [], limits: { fullP2b: 'incomplete', physicalIME: 'not-run', remoteDuringComposition: 'programmatic AppKit shared queue tested, including overlap and immediate continued input; physical IME not-run; UIKit marked text recorded separately in native report',
    crossBlockEditing: 'sibling, scoped blockquote boundaries and right-parent-preserving quote join tested; complex unselected suffix relocation remains rejected', commentReanchor: 'sibling split, undo/redo, SQLite reopen and native highlight tested; production sync open',
    crashAndCompaction: 'separate-durability-report', multipleViews: 'shared owner, authored branches, overlapping composition, continued-input and refresh races, CRDT selection epochs/history, detach/draft recovery and save retry tested; copied/redone sibling text lineage tested; disjoint-block structural drafts and same-paragraph Enter with pure remote prefix deletion tested; other same-block structural concurrency open', simulator: 'separate-native-report', signedDistribution: 'not-run' },
};
if (process.argv.includes('--check')) {
  const previous = JSON.parse(readFileSync(output));
  assert.equal(previous.status, 'passed');
  assert(previous.cases.length >= 80);
  assert(previous.cases.some(entry => entry.name === actBoundaryCase && entry.status === 'passed'), 'Missing act boundary gate');
  for (const name of workspaceTrashCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing chapter trash gate: ${name}`);
  for (const name of commentCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing chapter comment gate: ${name}`);
  for (const name of elementLibraryCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing element library gate: ${name}`);
  for (const name of elementFactsCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing element facts gate: ${name}`);
  for (const name of entityLinkCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing entity link gate: ${name}`);
  for (const name of storylineCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing storyline gate: ${name}`);
  for (const name of driftCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing drift gate: ${name}`);
  for (const name of metadataCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing metadata gate: ${name}`);
  for (const name of relationCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing relation gate: ${name}`);
  for (const name of wordCountCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing word count gate: ${name}`);
  for (const name of agentCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing writing assistant gate: ${name}`);
  for (const name of libraryCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing materials library gate: ${name}`);
  for (const name of timelineCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing story graph gate: ${name}`);
  for (const name of historyCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing version history gate: ${name}`);
  for (const name of editingCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing editing regression gate: ${name}`);
  for (const name of settingsCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing settings gate: ${name}`);
  for (const name of categoryCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing category page gate: ${name}`);
  for (const name of wholeBookCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing whole-book gate: ${name}`);
  for (const name of elementOverviewCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing element overview gate: ${name}`);
  for (const name of reviewCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing review gate: ${name}`);
  for (const name of workspaceRemoteChangeCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing workspace receive gate: ${name}`);
  for (const name of workspaceRemoteCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing canonical remote gate: ${name}`);
  for (const name of searchCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing search gate: ${name}`);
  for (const name of workspaceCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing workspace gate: ${name}`);
  assert(previous.cases.some(entry => entry.name === 'AppKit safe quote join preserves native suffix editing, history and reopen'));
  for (const name of styleCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing style gate: ${name}`);
  for (const name of prefixDeletionCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing prefix-deletion gate: ${name}`);
  assert(previous.cases.some(entry => entry.name === partialQuoteCase && entry.status === 'passed'), 'Missing partial quote deletion gate');
  for (const name of relocationCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing relocation gate: ${name}`);
  for (const name of remoteBlockCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing remote block gate: ${name}`);
  for (const name of remoteRecoveryCases) assert(previous.cases.some(entry => entry.name === name && entry.status === 'passed'), `Missing remote recovery gate: ${name}`);
  assert.equal(previous.source.fingerprint, report.source.fingerprint, 'P2b binding evidence is stale: run pnpm apple:binding:acceptance');
  console.log('P2b binding evidence matches its source inputs.');
  process.exit(0);
}
try {
  assert.equal(process.platform, 'darwin', 'AppKit binding acceptance requires macOS');
  mkdirSync(directory, { recursive: true });
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const target = `${arch}-apple-darwin`;
  writeFileSync(`${directory}/rust.log`, run('cargo', ['build', '--locked', '--manifest-path', 'crates/drifting-apple-bridge/Cargo.toml', '--target', target],
    { CARGO_TARGET_DIR: `${process.cwd()}/.local-data/apple-native/rust`, MACOSX_DEPLOYMENT_TARGET: '14.0' }));
  writeFileSync(`${directory}/swift.log`, run('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5',
    '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos14.0`,
    '-I', 'native/apple/FFI', '-L', `.local-data/apple-native/rust/${target}/debug`, '-ldrifting_apple_bridge', '-liconv', '-framework', 'AppKit',
    'native/apple/Shared/LabCore.swift', 'native/apple/Shared/DocumentBinding.swift', 'native/apple/Shared/DocumentStore.swift', 'native/apple/Shared/DocumentStyle.swift',
    'native/apple/macOS/NativeDocumentView.swift', 'native/apple/macOS/MacChapterWorkspace.swift', 'native/apple/macOS/BookOutlineViewController.swift', 'native/apple/Tests/BindingAcceptance.swift', 'native/apple/Tests/MultiViewAcceptance.swift', 'native/apple/Tests/SelectionAcceptance.swift', 'native/apple/Tests/DraftTransportAcceptance.swift', 'native/apple/Tests/InputQueueAcceptance.swift', 'native/apple/Tests/NativeHistoryAcceptance.swift', 'native/apple/Tests/PartialQuoteHistoryAcceptance.swift', 'native/apple/Tests/RemoteBlockAcceptance.swift', 'native/apple/Tests/RemoteRecoveryAcceptance.swift', 'native/apple/Tests/RelocationAcceptance.swift', 'native/apple/Tests/StyleAcceptance.swift', 'native/apple/Tests/TextIdentityAcceptance.swift', 'native/apple/Tests/FormattingAcceptance.swift', 'native/apple/Tests/OutlineAcceptance.swift', 'native/apple/Tests/WorkspaceTabsAcceptance.swift', 'native/apple/Shared/WorkspaceOutline.swift', 'native/apple/Shared/WorkspaceSearch.swift', 'native/apple/Tests/SearchAcceptance.swift', 'native/apple/Tests/WorkspaceRemoteProseAcceptance.swift', 'native/apple/Tests/WorkspaceRemoteChangesAcceptance.swift', 'native/apple/TestSupport/WorkspaceRemoteProseFixture.swift', 'native/apple/Tests/WorkspaceTrashAcceptance.swift', 'native/apple/Tests/ActBoundaryAcceptance.swift', 'native/apple/Shared/ChapterComments.swift', 'native/apple/macOS/MacChapterCommentsViewController.swift', 'native/apple/Tests/CommentAcceptance.swift', 'native/apple/Shared/WorkspaceElements.swift', 'native/apple/macOS/MacElementPageView.swift', 'native/apple/macOS/MacElementLibraryViewController.swift', 'native/apple/macOS/MacElementFactsEditor.swift', 'native/apple/Tests/ElementLibraryAcceptance.swift', 'native/apple/Tests/ElementFactsAcceptance.swift', 'native/apple/Tests/EntityLinkAcceptance.swift', 'native/apple/Shared/WorkspaceStorylines.swift', 'native/apple/macOS/MacStorylinePageView.swift', 'native/apple/macOS/MacStorylineLibraryViewController.swift', 'native/apple/macOS/MacChapterStorylinesSheet.swift', 'native/apple/Tests/StorylineAcceptance.swift', 'native/apple/Shared/WorkspaceDrifts.swift', 'native/apple/macOS/MacDriftPageView.swift', 'native/apple/macOS/MacDriftLibraryViewController.swift', 'native/apple/Tests/DriftAcceptance.swift', 'native/apple/Shared/WorkspaceMetadata.swift', 'native/apple/macOS/MacChapterPageView.swift', 'native/apple/macOS/MacProjectProfileSheet.swift', 'native/apple/Tests/MetadataAcceptance.swift', 'native/apple/Shared/WorkspaceRelations.swift', 'native/apple/macOS/MacRelationsView.swift', 'native/apple/macOS/MacRelationTypesViewController.swift', 'native/apple/Tests/RelationAcceptance.swift', 'native/apple/Shared/WorkspaceMetrics.swift', 'native/apple/macOS/MacWordCounts.swift', 'native/apple/Tests/WordCountAcceptance.swift', 'native/apple/Shared/AgentProviders.swift', 'native/apple/Shared/AgentCredentials.swift', 'native/apple/Shared/AgentTranscript.swift', 'native/apple/Shared/AgentDrivers.swift', 'native/apple/Shared/AgentTools.swift', 'native/apple/Shared/AgentPrompt.swift', 'native/apple/Shared/AgentRuntime.swift', 'native/apple/macOS/MacAgentPanel.swift', 'native/apple/Tests/AgentAcceptance.swift', 'native/apple/Shared/WorkspaceMaterials.swift', 'native/apple/Shared/BookTransfer.swift', 'native/apple/macOS/MacMaterialThumbnails.swift', 'native/apple/macOS/MacMaterialLibraryViewController.swift', 'native/apple/macOS/MacBookTransfer.swift', 'native/apple/Tests/LibraryAcceptance.swift', 'native/apple/Shared/WorkspaceTimeline.swift', 'native/apple/Shared/WorkspaceHistory.swift', 'native/apple/macOS/MacStoryGraphViewController.swift', 'native/apple/macOS/MacVersionHistorySheet.swift', 'native/apple/Tests/TimelineAcceptance.swift', 'native/apple/Tests/HistoryAcceptance.swift', 'native/apple/Tests/EditingRegressionAcceptance.swift', 'native/apple/macOS/MacSettings.swift', 'native/apple/macOS/MacSettingsWindow.swift', 'native/apple/Tests/SettingsAcceptance.swift', 'native/apple/macOS/MacElementTemplateEditor.swift', 'native/apple/macOS/MacCategoryPageView.swift', 'native/apple/Tests/CategoryAcceptance.swift', 'native/apple/Shared/WorkspaceBook.swift', 'native/apple/macOS/MacWholeBookViewController.swift', 'native/apple/macOS/MacBookStatsViewController.swift', 'native/apple/Tests/WholeBookAcceptance.swift', 'native/apple/Shared/ElementOverviewLayout.swift', 'native/apple/Shared/WorkspaceElementOverview.swift', 'native/apple/macOS/MacElementOverviewViewController.swift', 'native/apple/Tests/ElementOverviewAcceptance.swift', 'native/apple/Shared/WorkspaceReview.swift', 'native/apple/macOS/MacAssociationChips.swift', 'native/apple/macOS/MacReviewViewController.swift', 'native/apple/macOS/MacMemoBoardViewController.swift', 'native/apple/macOS/MacProjectDeletion.swift', 'native/apple/Tests/ReviewAcceptance.swift', '-lsqlite3', '-o', `${directory}/binding-acceptance`]));
  const result = run(`${directory}/binding-acceptance`, []);
  writeFileSync(`${directory}/result.log`, result);
  const test = JSON.parse(result.trim().split('\n').at(-1));
  assert.equal(test.status, 'passed'); assert(test.cases.length >= 80);
  assert(test.cases.includes(actBoundaryCase), 'Missing act boundary gate');
  for (const name of workspaceTrashCases) assert(test.cases.includes(name), `Missing chapter trash gate: ${name}`);
  for (const name of commentCases) assert(test.cases.includes(name), `Missing chapter comment gate: ${name}`);
  for (const name of elementLibraryCases) assert(test.cases.includes(name), `Missing element library gate: ${name}`);
  for (const name of elementFactsCases) assert(test.cases.includes(name), `Missing element facts gate: ${name}`);
  for (const name of entityLinkCases) assert(test.cases.includes(name), `Missing entity link gate: ${name}`);
  for (const name of storylineCases) assert(test.cases.includes(name), `Missing storyline gate: ${name}`);
  for (const name of driftCases) assert(test.cases.includes(name), `Missing drift gate: ${name}`);
  for (const name of metadataCases) assert(test.cases.includes(name), `Missing metadata gate: ${name}`);
  for (const name of relationCases) assert(test.cases.includes(name), `Missing relation gate: ${name}`);
  for (const name of wordCountCases) assert(test.cases.includes(name), `Missing word count gate: ${name}`);
  for (const name of agentCases) assert(test.cases.includes(name), `Missing writing assistant gate: ${name}`);
  for (const name of libraryCases) assert(test.cases.includes(name), `Missing materials library gate: ${name}`);
  for (const name of timelineCases) assert(test.cases.includes(name), `Missing story graph gate: ${name}`);
  for (const name of historyCases) assert(test.cases.includes(name), `Missing version history gate: ${name}`);
  for (const name of editingCases) assert(test.cases.includes(name), `Missing editing regression gate: ${name}`);
  for (const name of settingsCases) assert(test.cases.includes(name), `Missing settings gate: ${name}`);
  for (const name of categoryCases) assert(test.cases.includes(name), `Missing category page gate: ${name}`);
  for (const name of wholeBookCases) assert(test.cases.includes(name), `Missing whole-book gate: ${name}`);
  for (const name of elementOverviewCases) assert(test.cases.includes(name), `Missing element overview gate: ${name}`);
  for (const name of reviewCases) assert(test.cases.includes(name), `Missing review gate: ${name}`);
  for (const name of workspaceRemoteChangeCases) assert(test.cases.includes(name), `Missing workspace receive gate: ${name}`);
  for (const name of workspaceRemoteCases) assert(test.cases.includes(name), `Missing canonical remote gate: ${name}`);
  for (const name of searchCases) assert(test.cases.includes(name), `Missing search gate: ${name}`);
  for (const name of workspaceCases) assert(test.cases.includes(name), `Missing workspace gate: ${name}`);
  for (const name of styleCases) assert(test.cases.includes(name), `Missing style gate: ${name}`);
  for (const name of prefixDeletionCases) assert(test.cases.includes(name), `Missing prefix-deletion gate: ${name}`);
  assert(test.cases.includes(partialQuoteCase), 'Missing partial quote deletion gate');
  for (const name of remoteBlockCases) assert(test.cases.includes(name), `Missing remote block gate: ${name}`);
  for (const name of remoteRecoveryCases) assert(test.cases.includes(name), `Missing remote recovery gate: ${name}`);
  for (const name of relocationCases) assert(test.cases.includes(name), `Missing relocation gate: ${name}`);
  report.cases = test.cases.map(name => ({ name, status: 'passed' }));
  assert.equal(fingerprint(), report.source.fingerprint, 'Binding inputs changed during acceptance');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = error.message.replaceAll(process.cwd(), '<repository>'); process.exitCode = 1;
} finally {
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.status}: ${output}`);
  if (report.failure) console.error(report.failure);
}
