use dr_doc::prose::{EmbedKind, EmbedView, FileEmbedLook, ProseDoc};
use dr_mirror::body::{FileLinks, Para, parse_with, render_with};
use dr_mirror::layout::AssetFile;
use dr_mirror::merge::{Merged, merge_peer, merge_with};
use dr_model::id::EmbedId;
use dr_model::kind::ListKind;
use dr_model::pos::PosKey;
use dr_model::v3::{EmbedAlign, EmbedSize};
use dr_model::{DocId, Origin};
use dr_testkit::seed::{DEFAULT_SEED, Preset, SeedFile, generate_v3};
use loro::{Frontiers, LoroDoc};

fn seeded_prose(text: &str) -> ProseDoc {
    let mut corpus = generate_v3(Preset::Tiny, DEFAULT_SEED).unwrap();
    let mut prose = corpus
        .books
        .remove(0)
        .prose
        .into_iter()
        .find(|d| matches!(d.doc_id(), DocId::Body(_)))
        .unwrap();
    let (r, _) = prose.edit(Origin::User, |txn| {
        txn.delete(0..txn.view().len() - 1)?;
        txn.insert_paragraphs(0, text).map(|_| ())
    });
    r.unwrap();
    prose
}

fn ingest(prose: &mut ProseDoc, at: &Frontiers, body: &str, links: &FileLinks<'_>) -> Merged {
    let copy = LoroDoc::new();
    copy.import(&prose.export_snapshot().unwrap()).unwrap();
    let id = prose.doc_id();
    let read = parse_with(body, links);
    let merged = merge_with(
        &copy,
        id,
        at,
        &read.paragraphs,
        merge_peer(id, at, body.as_bytes()),
        None,
        links,
    )
    .unwrap()
    .unwrap();
    if !merged.update.is_empty() {
        prose.import(&merged.update, Origin::Mirror).unwrap();
    }
    merged
}

fn written(prose: &ProseDoc, links: &FileLinks<'_>) -> String {
    let view = prose.view();
    let paras: Vec<_> = view
        .paragraphs()
        .map(|p| Para::project(&view, &p, links))
        .collect();
    render_with(&paras, links)
}

#[test]
fn overlapping_words_keep_both_insertions_and_name_the_block() {
    let mut prose = seeded_prose("安娜在镇口等车。\n下雨了。\n钟响了。");
    let links = FileLinks::default();
    let at = prose.frontiers();
    let before = written(&prose, &links);
    let block = prose.view().paragraphs().next().unwrap().id.unwrap();
    let (r, _) = prose.edit(Origin::User, |txn| txn.insert_text(5, "很久"));
    r.unwrap();
    let file = before.replace("口等", "口一直等");
    let merged = ingest(&mut prose, &at, &file, &links);
    assert_eq!(merged.conflicts, [block]);
    let got = written(&prose, &links);
    assert!(got.contains("很久") && got.contains("一直"));
    let head = prose.frontiers();
    ingest(&mut prose, &at, &file, &links);
    assert_eq!(prose.frontiers(), head);

    let before = written(&prose, &links);
    let (r, _) = prose.edit(Origin::User, |txn| txn.insert_text(0, "刚才，"));
    r.unwrap();
    let merged = ingest(
        &mut prose,
        &head,
        &before.replace("钟响了", "钟响了三次"),
        &links,
    );
    assert!(merged.conflicts.is_empty());
    let current = written(&prose, &links);
    assert!(current.contains("刚才") && current.contains("钟响了三次"));
}

#[test]
fn checklist_ticks_and_edits_keep_the_paragraph_id() {
    let mut prose = seeded_prose("前文。\n核对钟楼几点报时。\n后文。");
    let links = FileLinks::default();
    let at = prose.frontiers();
    ingest(
        &mut prose,
        &at,
        "前文。\n\n- [ ] 核对钟楼几点报时。\n\n后文。\n",
        &links,
    );
    let item = prose.view().paragraphs().nth(1).unwrap();
    assert_eq!(item.attrs.list, Some(ListKind::Task));
    assert!(!item.attrs.checked);
    let body = written(&prose, &links).replace("[ ] 核对钟楼", "[x] 再核对钟楼");
    let at = prose.frontiers();
    ingest(&mut prose, &at, &body, &links);
    let after = prose.view().paragraphs().nth(1).unwrap();
    assert_eq!(after.id, item.id);
    assert!(after.attrs.checked);
    assert_eq!(after.text(), "再核对钟楼几点报时。");
}

#[test]
fn a_table_edit_merges_in_the_existing_cells_keeps_unrelated_content_and_adds_a_row() {
    let mut prose = seeded_prose("门开着。");
    let table_id = EmbedId::parse("table").unwrap();
    let (r, _) = prose.edit(Origin::User, |txn| {
        let table = txn.insert_embed(0, &table_id, &EmbedKind::Table)?;
        let first = PosKey::first();
        table.add_row("r1", &first)?;
        table.add_row("r2", &first.after())?;
        table.add_col("name", &first)?;
        table.add_col("value", &first.after())?;
        for (row, col, text) in [
            ("r1", "name", "物品"),
            ("r1", "value", "状态"),
            ("r2", "name", "钥匙"),
            ("r2", "value", "在桌上"),
        ] {
            table.set_cell(row, col, text)?;
        }
        Ok(())
    });
    r.unwrap();
    let links = FileLinks::default();
    let at = prose.frontiers();
    let before = written(&prose, &links);
    let unchanged = ingest(&mut prose, &at, &before, &links);
    assert!(unchanged.update.is_empty());
    let (r, _) = prose.edit(Origin::User, |txn| {
        txn.table(&table_id)?.set_cell("r2", "name", "铜钥匙")
    });
    r.unwrap();

    let file = before.replace(
        "| 钥匙 | 在桌上 |",
        "| 石头 | 在门口 |\n| 钥匙 | 在窗台上 |",
    );
    ingest(&mut prose, &at, &file, &links);
    let EmbedView::Table {
        rows, cols, cells, ..
    } = prose.view().embed(&table_id).unwrap()
    else {
        panic!("table replaced")
    };
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[2].id, "r2");
    assert_eq!(cols[1].id, "value");
    assert_eq!(cells[&("r2".into(), "name".into())], "铜钥匙");
    assert_eq!(cells[&("r2".into(), "value".into())], "在窗台上");
    let at = prose.frontiers();
    let before = written(&prose, &links);
    let file = before
        .replace("| --- | --- |", "| --- |")
        .replace("门开着。", "门关上了。");
    ingest(&mut prose, &at, &file, &links);
    assert!(matches!(
        prose.view().embed(&table_id),
        Some(EmbedView::Table { .. })
    ));
    assert!(written(&prose, &links).contains("门关上了。"));
}

#[test]
fn an_image_caption_edit_keeps_look_and_deleting_its_line_only_removes_the_embed() {
    let mut prose = seeded_prose("她在楼下。");
    let fixture = SeedFile::image("file", 32, 32);
    let id = EmbedId::parse("image").unwrap();
    let (r, _) = prose.edit(Origin::User, |txn| {
        txn.insert_embed(0, &id, &EmbedKind::Asset(fixture.id.clone()))?;
        txn.set_file_embed_look(
            &id,
            &FileEmbedLook {
                size: Some(EmbedSize::Small),
                align: Some(EmbedAlign::Left),
                caption: "钟楼".into(),
            },
        )
    });
    r.unwrap();
    let files = [AssetFile {
        id: fixture.id,
        path: "素材库/钟楼.png".into(),
        name: "钟楼.png".into(),
        kind: fixture.kind,
        present: true,
    }];
    let links = FileLinks::new("雨夜.md", &files);
    let at = prose.frontiers();
    let body = written(&prose, &links).replace("![钟楼]", "![雨夜的钟楼]");
    ingest(&mut prose, &at, &body, &links);
    let EmbedView::Asset { asset, look, .. } = prose.view().embed(&id).unwrap() else {
        panic!("image replaced")
    };
    assert_eq!(asset.as_ref(), Some(&files[0].id));
    assert_eq!(look.size, Some(EmbedSize::Small));
    assert_eq!(look.align, Some(EmbedAlign::Left));
    assert_eq!(look.caption, "雨夜的钟楼");

    let at = prose.frontiers();
    ingest(&mut prose, &at, "她在楼下。\n", &links);
    assert!(prose.view().embed_refs().is_empty());
    assert_eq!(written(&prose, &links), "她在楼下。\n");
}

/// `门开着。` and a two-row table (`物品 | 状态`, `钥匙 | 在桌上`).
fn with_table() -> (ProseDoc, EmbedId) {
    let mut prose = seeded_prose("门开着。");
    let table_id = EmbedId::parse("table").unwrap();
    let (r, _) = prose.edit(Origin::User, |txn| {
        let table = txn.insert_embed(0, &table_id, &EmbedKind::Table)?;
        let first = PosKey::first();
        table.add_row("r1", &first)?;
        table.add_row("r2", &first.after())?;
        table.add_col("name", &first)?;
        table.add_col("value", &first.after())?;
        for (row, col, text) in [
            ("r1", "name", "物品"),
            ("r1", "value", "状态"),
            ("r2", "name", "钥匙"),
            ("r2", "value", "在桌上"),
        ] {
            table.set_cell(row, col, text)?;
        }
        Ok(())
    });
    r.unwrap();
    (prose, table_id)
}

fn table_block(prose: &ProseDoc) -> dr_model::id::BlockId {
    prose
        .view()
        .paragraphs()
        .find(|p| p.embed().is_some())
        .and_then(|p| p.id)
        .unwrap()
}

fn rows_of(prose: &ProseDoc, id: &EmbedId) -> Vec<Vec<String>> {
    let Some(EmbedView::Table {
        rows, cols, cells, ..
    }) = prose.view().embed(id)
    else {
        return Vec::new();
    };
    rows.iter()
        .map(|r| {
            cols.iter()
                .map(|c| {
                    cells
                        .get(&(r.id.clone(), c.id.clone()))
                        .cloned()
                        .unwrap_or_default()
                })
                .collect()
        })
        .collect()
}

#[test]
fn a_row_the_file_replaces_keeps_the_apps_edit_beside_the_files_row() {
    let links = FileLinks::default();
    let replaced =
        |prose: &ProseDoc| written(prose, &links).replace("| 钥匙 | 在桌上 |", "| 石头 | 在门口 |");

    // Without an App edit the old row simply goes.
    let (mut prose, table) = with_table();
    let at = prose.frontiers();
    let file = replaced(&prose);
    let merged = ingest(&mut prose, &at, &file, &links);
    assert!(merged.conflicts.is_empty());
    assert_eq!(
        rows_of(&prose, &table),
        [["物品", "状态"], ["石头", "在门口"]]
    );

    // The App changed a cell of that row meanwhile: its row stays, the
    // file's row is added, and the paragraph gets one conflict.
    let (mut prose, table) = with_table();
    let at = prose.frontiers();
    let file = replaced(&prose);
    let (r, _) = prose.edit(Origin::User, |txn| {
        txn.table(&table)?.set_cell("r2", "name", "铜钥匙")
    });
    r.unwrap();
    let merged = ingest(&mut prose, &at, &file, &links);
    assert_eq!(merged.conflicts, [table_block(&prose)]);
    let rows = rows_of(&prose, &table);
    assert_eq!(rows.len(), 3, "{rows:?}");
    assert!(rows.contains(&vec!["铜钥匙".to_owned(), "在桌上".to_owned()]));
    assert!(rows.contains(&vec!["石头".to_owned(), "在门口".to_owned()]));
    // Replaying the same file over the same base changes nothing more.
    let head = prose.frontiers();
    let again = ingest(&mut prose, &at, &file, &links);
    assert!(again.replayed);
    assert_eq!(again.frontiers, merged.frontiers);
    assert_eq!(prose.frontiers(), head);
    assert_eq!(rows_of(&prose, &table), rows);
}

#[test]
fn a_column_the_file_drops_keeps_the_apps_edit() {
    let links = FileLinks::default();
    let (mut prose, table) = with_table();
    let at = prose.frontiers();
    let file = written(&prose, &links)
        .replace("| 物品 | 状态 |", "| 物品 |")
        .replace("| --- | --- |", "| --- |")
        .replace("| 钥匙 | 在桌上 |", "| 钥匙 |");
    let (r, _) = prose.edit(Origin::User, |txn| {
        txn.table(&table)?.set_cell("r2", "value", "在窗台上")
    });
    r.unwrap();
    let merged = ingest(&mut prose, &at, &file, &links);
    assert_eq!(merged.conflicts, [table_block(&prose)]);
    assert_eq!(
        rows_of(&prose, &table),
        [["物品", "状态"], ["钥匙", "在窗台上"]]
    );
}

#[test]
fn a_column_the_file_drops_keeps_words_in_a_row_the_app_added() {
    let links = FileLinks::default();
    let (mut prose, table) = with_table();
    let at = prose.frontiers();
    let file = written(&prose, &links)
        .replace("| 物品 | 状态 |", "| 物品 |")
        .replace("| --- | --- |", "| --- |")
        .replace("| 钥匙 | 在桌上 |", "| 钥匙 |");
    let (result, _) = prose.edit(Origin::User, |txn| {
        let table = txn.table(&table)?;
        table.add_row("new-row", &PosKey::first().after().after())?;
        table.set_cell("new-row", "name", "石头")?;
        table.set_cell("new-row", "value", "在门口")?;
        Ok(())
    });
    result.unwrap();
    let merged = ingest(&mut prose, &at, &file, &links);
    assert_eq!(merged.conflicts, [table_block(&prose)]);
    assert_eq!(
        rows_of(&prose, &table),
        [["物品", "状态"], ["钥匙", "在桌上"], ["石头", "在门口"]]
    );
}

#[test]
fn a_row_the_app_removed_comes_back_with_the_files_edit() {
    let links = FileLinks::default();
    let (mut prose, table) = with_table();
    let at = prose.frontiers();
    let file = written(&prose, &links).replace("| 钥匙 | 在桌上 |", "| 钥匙 | 在桌子上 |");
    let (r, _) = prose.edit(Origin::User, |txn| txn.table(&table)?.remove_row("r2"));
    r.unwrap();
    let merged = ingest(&mut prose, &at, &file, &links);
    assert_eq!(merged.conflicts, [table_block(&prose)]);
    assert_eq!(
        rows_of(&prose, &table),
        [["物品", "状态"], ["钥匙", "在桌子上"]]
    );
}

#[test]
fn both_sides_editing_one_cell_keep_both_words_and_name_the_table() {
    let links = FileLinks::default();
    let (mut prose, table) = with_table();
    let at = prose.frontiers();
    let file = written(&prose, &links).replace("在桌上", "在桌面上");
    let (r, _) = prose.edit(Origin::User, |txn| {
        txn.table(&table)?.cell("r2", "value")?.insert(2, "子")?;
        Ok(())
    });
    r.unwrap();
    let merged = ingest(&mut prose, &at, &file, &links);
    assert_eq!(merged.conflicts, [table_block(&prose)]);
    let cell = &rows_of(&prose, &table)[1][1];
    assert!(cell.contains('子') && cell.contains('面'), "{cell}");
}

#[test]
fn deleting_a_table_the_app_edited_keeps_it_with_one_conflict() {
    let links = FileLinks::default();
    let deleted = "门开着。\n";

    let (mut prose, table) = with_table();
    let at = prose.frontiers();
    let merged = ingest(&mut prose, &at, deleted, &links);
    assert!(merged.conflicts.is_empty());
    assert!(prose.view().embed_refs().is_empty());

    let (mut prose, table_after) = with_table();
    assert_eq!(table, table_after);
    let at = prose.frontiers();
    let block = table_block(&prose);
    let (r, _) = prose.edit(Origin::User, |txn| {
        txn.table(&table)?.set_cell("r2", "value", "在窗台上")
    });
    r.unwrap();
    let merged = ingest(&mut prose, &at, deleted, &links);
    assert_eq!(merged.conflicts, [block]);
    assert_eq!(
        rows_of(&prose, &table),
        [["物品", "状态"], ["钥匙", "在窗台上"]]
    );
    assert!(written(&prose, &links).contains("| 钥匙 | 在窗台上 |"));
}
